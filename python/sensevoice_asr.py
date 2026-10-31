"""本机 SenseVoice 识别子进程：读 JSON 行，回 JSON 行。

请求：{"id": 1, "pcm": "<base64 s16le>", "sampleRate": 16000}
回复：{"id": 1, "ok": true, "text": "...", "lang": "zh", "emotion": "HAPPY", "event": "Speech", "ms": 120}
出错：{"id": 1, "ok": false, "error": "..."}

模型只在第一次请求时加载；stdin 关闭即退出。
"""

import base64
import json
import sys
import time

import numpy as np
import sherpa_onnx

sys.stdout.reconfigure(encoding="utf-8", newline="\n")
sys.stdin.reconfigure(encoding="utf-8")


def strip_tag(value):
    text = (value or "").strip()
    if text.startswith("<|") and text.endswith("|>"):
        text = text[2:-2]
    return text


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "用法：sensevoice_asr.py <模型目录> <线程数>"}), flush=True)
        return 2
    model_dir, threads_text = sys.argv[1], sys.argv[2]
    recognizer = None

    def ensure():
        nonlocal recognizer
        if recognizer is None:
            recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=f"{model_dir}/model.int8.onnx",
                tokens=f"{model_dir}/tokens.txt",
                num_threads=max(1, int(threads_text)),
                use_itn=True,
                debug=False,
                language="auto",
            )
        return recognizer

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = None
        try:
            request = json.loads(line)
            ident = request.get("id")
            started = time.time()
            samples = np.frombuffer(base64.b64decode(request["pcm"]), dtype=np.int16).astype(np.float32) / 32768.0
            rate = int(request.get("sampleRate") or 16000)
            stream = ensure().create_stream()
            stream.accept_waveform(sample_rate=rate, waveform=samples)
            ensure().decode_stream(stream)
            result = stream.result
            print(json.dumps({
                "id": ident,
                "ok": True,
                "text": result.text,
                "lang": strip_tag(getattr(result, "lang", "")),
                "emotion": strip_tag(getattr(result, "emotion", "")),
                "event": strip_tag(getattr(result, "event", "")),
                "ms": round((time.time() - started) * 1000),
            }, ensure_ascii=False), flush=True)
        except Exception as error:  # 单个请求失败不退出进程
            print(json.dumps({"id": (request.get("id") if isinstance(request, dict) else None), "ok": False, "error": str(error)}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
