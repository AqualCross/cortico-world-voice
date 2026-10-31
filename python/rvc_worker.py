"""本机 RVC 变声子进程：读 JSON 行，回 JSON 行。

由 `src/rvc.ts` 启动：`python rvc_worker.py <上游源码目录> <模型资产目录> <音色目录>`。
源码是依赖页装的那份（只读），资产目录里是 hubert_base/ 与 rmvpe/，音色目录里是 .pth 与同名 .index。

就绪：{"type":"ready","device":"cuda:0"}（模型在第一次转换时才载入，换音色只付一次加载）
请求：{"id":1,"input":"a.mp3","output":"b.wav","model":"<绝对路径 .pth>","pitch":0,"indexRate":0.3,"protect":0.33}
回复：{"id":1,"ok":true,"ms":812,"loadMs":17320,"sampleRate":40000}
出错：{"id":1,"ok":false,"kind":"param|decode|infer","error":"..."}

stdout 只放协议行：先 dup 一份原 stdout 给协议，再把 fd 1 指到 stderr，
这样上游和 torch 的 print 不会混进协议。stdin 关闭即退出。
"""

import json
import os
import sys
import time
import traceback
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: rvc_worker.py <codeDir> <assetsDir> <voicesDir>", file=sys.stderr)
        return 2
    code = os.path.abspath(sys.argv[1])
    assets = os.path.abspath(sys.argv[2])
    voices = os.path.abspath(sys.argv[3])

    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)

    def emit(payload) -> None:
        proto.write(json.dumps(payload, ensure_ascii=False) + "\n")
        proto.flush()

    def fail(kind: str, error: str, ident=None) -> None:
        emit({"id": ident, "ok": False, "kind": kind, "error": error})

    if not os.path.isdir(code):
        fail("param", "RVC 源码目录不存在：%s（去「依赖」页对 RVC 点「获取」）" % code)
        return 1
    missing = [
        path
        for path in (
            os.path.join(assets, "hubert_base", "config.json"),
            os.path.join(assets, "hubert_base", "pytorch_model.bin"),
            os.path.join(assets, "rmvpe", "rmvpe.pt"),
        )
        if not os.path.isfile(path)
    ]
    if missing:
        fail("param", "缺少 RVC 资产：%s（去「依赖」页对 RVC 点「获取」）" % "、".join(missing))
        return 1

    # 上游按当前目录找 i18n/locale、configs/* 与 tools/，且在导入时就把代码根写进 sys.path。
    os.chdir(code)
    sys.path.insert(0, code)
    os.environ["weight_root"] = voices
    os.environ["index_root"] = voices
    os.environ["outside_index_root"] = voices
    os.environ["rmvpe_root"] = os.path.join(assets, "rmvpe")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

    started = time.time()
    try:
        from configs.config import Config  # noqa: E402  先 chdir 再 import

        saved_argv, sys.argv = sys.argv, [sys.argv[0]]
        try:
            config = Config()
        finally:
            sys.argv = saved_argv
        import soundfile as sf  # noqa: E402
        from infer import hubert  # noqa: E402
        from infer.vc.modules import VC  # noqa: E402

        # 上游把 hubert 资产写死在源码根下；这里改指到模型的资产目录（模块读的是这个全局量）。
        hubert.HUBERT_MODEL_PATH = Path(assets, "hubert_base").resolve()
        vc = VC(config)
    except Exception:
        fail("infer", "RVC 推理代码载入失败：%s" % traceback.format_exc()[-1500:])
        return 1

    loaded = {"model": "", "index": ""}
    emit({"type": "ready", "device": str(config.device), "loadMs": int((time.time() - started) * 1000)})

    def load_model(model: str) -> tuple:
        """载入音色，返回 (名字, 索引路径)；同一个文件不重复载入。"""
        path = os.path.abspath(model)
        if not os.path.isfile(path):
            raise LookupError("音色文件不在了：%s" % path)
        name = os.path.basename(path)
        if loaded["model"] == path:
            return name, loaded["index"]
        began = time.time()
        vc.get_vc(name)
        index = os.path.splitext(path)[0] + ".index"
        loaded["model"] = path
        loaded["index"] = index if os.path.isfile(index) else ""
        print("[rvc] 载入音色 %s（index：%s，%d ms）" % (name, loaded["index"] or "无", int((time.time() - began) * 1000)), file=sys.stderr)
        return name, loaded["index"]

    def convert(req: dict) -> None:
        ident = req.get("id")
        model = str(req.get("model") or "").strip()
        source = str(req.get("input") or "").strip()
        target = str(req.get("output") or "").strip()
        if not model:
            fail("param", "没有指定音色 .pth", ident)
            return
        if not source or not os.path.isfile(source):
            fail("decode", "读不到输入音频：%s" % source, ident)
            return
        if not target:
            fail("param", "没有指定输出路径", ident)
            return
        began = time.time()
        try:
            _, index = load_model(model)
            load_ms = int((time.time() - began) * 1000)
        except Exception:
            fail("param", "载入音色失败：%s" % traceback.format_exc()[-1200:], ident)
            return
        began = time.time()
        try:
            status, result = vc.vc_single(
                0,
                source,
                int(req.get("pitch") or 0),
                "rmvpe",
                index,
                float(req.get("indexRate", 0.3)),
                0,
                1.0,
                float(req.get("protect", 0.33)),
            )
        except Exception:
            fail("infer", traceback.format_exc()[-1500:], ident)
            return
        if not result or result[0] is None or result[1] is None:
            fail("infer", str(status)[-1500:], ident)
            return
        try:
            os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
            sf.write(target, result[1], int(result[0]))
        except Exception:
            fail("infer", "写出失败：%s" % traceback.format_exc()[-800:], ident)
            return
        emit({"id": ident, "ok": True, "ms": int((time.time() - began) * 1000), "loadMs": load_ms, "sampleRate": int(result[0])})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            print("[rvc] 忽略非 JSON 行：%s" % line[:200], file=sys.stderr)
            continue
        op = req.get("op")
        if op == "shutdown":
            break
        if op == "convert":
            convert(req)
            continue
        print("[rvc] 未知指令：%s" % op, file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
