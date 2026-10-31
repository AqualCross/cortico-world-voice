"""本机 DiffSinger 唱歌子进程：读 JSON 行，回 JSON 行。

由 `src/singer.ts` 启动：`python diffsinger_worker.py <声库目录>`。
第一次唱时才拉起（载声库要十几秒）；Node 侧空闲就掐掉进程，下次再拉。

就绪：{"type":"ready","voicebank":"...","sampleRate":44100,"speakers":[]}
请求：{"id":1,"out":"...wav","lyrics":"...","bpm":96,"keyShift":0,"scale":"major","seed":0,"speaker":"","maxSeconds":60}
回复：{"id":1,"ok":true,"ms":9000,"seconds":12.4,"notes":32,"sampleRate":44100}
出错：{"id":1,"ok":false,"kind":"param|infer","error":"..."}

链路：歌词 → 按标点断句 → 逐字查拼音音素（声库音素表里没有的字不唱）
     → 按调式随机走一条旋律 → DS 段落（note_seq / ph_seq / ph_num / note_dur）
     → diffsinger_utau 的 dur → pitch → variance → acoustic → vocoder → wav。
stdout 只放协议行；库里与 onnxruntime 的打印全部改道 stderr。
"""

import hashlib
import json
import os
import random
import re
import sys
import time
import traceback
from pathlib import Path

_PROTO = sys.stdout
sys.stdout = sys.stderr

# 五声音阶（相对主音的半音数）。
SCALES = {
    "major": (0, 2, 4, 7, 9),
    "minor": (0, 3, 5, 7, 10),
}

# 句读与空白都要断句；其余标点直接丢。
PHRASE_BREAK = re.compile(r"[，。！？、；：,.!?;:\s…—~～\[\]【】()（）\"'“”‘’]+")
HAN = re.compile(r"[\u4e00-\u9fff]")
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def send(payload):
    _PROTO.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTO.flush()


def note_name(midi):
    return "%s%d" % (NOTE_NAMES[midi % 12], midi // 12 - 1)


def basic_optimization_only():
    """绮萱的声学模型在 onnxruntime 的 extended 优化下会原生崩溃（Windows 访问冲突），
    固定用 basic。库自己建 SessionOptions，只能从这里包一层。"""
    import onnxruntime as ort

    original = ort.InferenceSession

    def session(model, sess_options=None, **kwargs):
        options = sess_options or ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        return original(model, sess_options=options, **kwargs)

    ort.InferenceSession = session


class Song:
    def __init__(self, bank_dir):
        self.bank = Path(bank_dir)
        self.pred = None
        self.words = None
        self.phones = None
        self.rate = 44100

    def load(self):
        basic_optimization_only()
        from diffsinger_utau.voice_bank import PredAll
        from diffsinger_utau.voice_bank.commons.ds_reader import DSTextReplacer

        self.pred = PredAll(self.bank)
        self.words = DSTextReplacer()
        self.rate = int(self.pred.dsvocoder.sample_rate)
        table = getattr(self.pred.dsacoustic, "phonemes", None)
        if table is not None:
            self.phones = set(table.content.keys())
        return self.speakers()

    def speakers(self):
        """声库里的音色短名（acoustic_Normal → Normal）；单音色声库这里是空的。"""
        names = []
        for speaker in getattr(self.pred.dsacoustic, "speakers", None) or []:
            short = str(getattr(speaker, "speaker_name", "") or "").rsplit("/", 1)[-1]
            for prefix in ("acoustic_", "variance_", "dur_", "pitch_"):
                if short.startswith(prefix):
                    short = short[len(prefix):]
                    break
            if short:
                names.append(short)
        return names

    def phonemes_of(self, char):
        """一个汉字 → 声库音素表里的音素（裸音素补 zh/ 前缀）；查不到返回空。"""
        raw = self.words.get_phonemes(char, self.words.opencpop_dict)
        if not raw:
            return []
        if self.phones is None:
            return list(raw)
        mapped = []
        for phoneme in raw:
            if phoneme in self.phones:
                mapped.append(phoneme)
            elif "zh/%s" % phoneme in self.phones:
                mapped.append("zh/%s" % phoneme)
            else:
                return []
        return mapped

    def melody(self, lyrics, bpm, key_shift, scale, seed, max_seconds):
        """每个字一个音符，句末留半拍休止；返回 (notes, 实际唱出的字序列)。"""
        unit = 60.0 / max(40, bpm)
        steps = SCALES.get(scale, SCALES["major"])
        rng = random.Random(seed)
        base = 60 + key_shift
        notes = []
        sung = []
        total = 0.0

        for phrase in (part for part in PHRASE_BREAK.split(lyrics) if part):
            units = []
            for char in HAN.findall(phrase):
                phones = self.phonemes_of(char)
                if phones:
                    units.append((char, phones))
            if not units:
                continue
            degree = rng.randrange(len(steps))
            octave = 4
            for index, (char, phones) in enumerate(units):
                duration = unit * (1.0 if index == len(units) - 1 else 0.5)
                if total + duration > max_seconds:
                    break
                notes.append((phones, base + 12 * (octave - 4) + steps[degree], duration))
                sung.append(char)
                total += duration
                move = rng.choices((-1, 0, 1), weights=(3, 4, 3))[0]
                if degree + move < 0 or degree + move >= len(steps):
                    move = -move
                degree += move
                if degree >= len(steps):
                    degree -= len(steps)
                    octave = min(5, octave + 1)
                elif degree < 0:
                    degree += len(steps)
                    octave = max(3, octave - 1)
            if notes and total + unit * 0.5 <= max_seconds:
                notes.append((["SP"], None, unit * 0.5))
                total += unit * 0.5
            if total >= max_seconds:
                break

        while notes and notes[-1][0] == ["SP"]:
            notes.pop()
        return notes, "".join(sung)

    @staticmethod
    def section(notes, text):
        phones = []
        counts = []
        keys = []
        durations = []
        for phone_list, midi, duration in notes:
            phones.extend(phone_list)
            counts.append(len(phone_list))
            keys.append("rest" if midi is None else note_name(midi))
            durations.append(round(duration, 4))
        return {
            "offset": 0,
            "text": text,
            "ph_seq": " ".join(phones),
            "ph_num": " ".join(str(count) for count in counts),
            "note_seq": " ".join(keys),
            "note_slur": " ".join("0" for _ in keys),
            "note_dur": " ".join(str(value) for value in durations),
        }

    def sing(self, job):
        from diffsinger_utau.voice_bank.commons.ds_reader import DSReader

        lyrics = str(job.get("lyrics") or "").strip()
        if not lyrics:
            raise ValueError("歌词为空")
        bpm = int(job.get("bpm") or 96)
        key_shift = int(job.get("keyShift") or 0)
        scale = str(job.get("scale") or "major")
        # seed=0 时按歌词取固定值：同一首词每次同一条旋律。
        seed = int(job.get("seed") or 0) or int(hashlib.sha1(lyrics.encode("utf-8")).hexdigest()[:8], 16)
        max_seconds = float(job.get("maxSeconds") or 60)
        target = Path(job["out"])

        notes, text = self.melody(lyrics, bpm, key_shift, scale, seed, max_seconds)
        if not notes:
            raise ValueError("没有能唱的字：要汉字，且声库音素表里有它的读音")

        section = DSReader.DSSection(self.section(notes, text))
        target.parent.mkdir(parents=True, exist_ok=True)
        work = target.parent / ("%s.work" % target.stem)
        work.mkdir(parents=True, exist_ok=True)
        try:
            found = self.pred.predict_full_pipeline(
                ds=section,
                lang="zh",
                speaker=str(job.get("speaker") or ""),
                key_shift=0,  # 旋律里已经按 keyShift 生成
                pitch_steps=int(job.get("pitchSteps") or 10),
                variance_steps=int(job.get("varianceSteps") or 10),
                acoustic_steps=int(job.get("acousticSteps") or 20),
                gender=float(job.get("gender") or 0),
                output_dir=str(work),
                save_intermediate=False,
            )
            produced = Path(found["audio_path"])
            if not produced.exists():
                raise RuntimeError("声码器没有写出音频：%s" % produced)
            os.replace(produced, target)
        finally:
            for leftover in work.glob("*.ds"):
                leftover.unlink(missing_ok=True)
            try:
                work.rmdir()
            except OSError:
                pass
        return {
            "seconds": round(len(found["wav"]) / float(self.rate), 3),
            "notes": len(notes),
            "sungChars": len(text),
            "sampleRate": self.rate,
        }


def main():
    if len(sys.argv) < 2:
        send({"type": "fatal", "error": "用法：diffsinger_worker.py <声库目录>"})
        return 2
    bank = Path(sys.argv[1])
    if not bank.is_dir():
        send({"type": "fatal", "error": "声库目录不存在：%s" % bank})
        return 2

    song = Song(bank)
    try:
        speakers = song.load()
    except Exception:
        send({"type": "fatal", "error": "声库加载失败：%s" % traceback.format_exc()[-1200:]})
        return 1
    send({"type": "ready", "voicebank": bank.name, "sampleRate": song.rate, "speakers": speakers})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except ValueError:
            print("[sing] 忽略非 JSON 行：%s" % line[:200], file=sys.stderr)
            continue
        op = job.get("op")
        if op == "shutdown":
            break
        if op != "sing":
            send({"id": job.get("id"), "ok": False, "kind": "param", "error": "未知 op：%s" % op})
            continue
        started = time.time()
        try:
            stats = song.sing(job)
            send({"id": job.get("id"), "ok": True, "ms": int((time.time() - started) * 1000), **stats})
        except ValueError as error:
            send({"id": job.get("id"), "ok": False, "kind": "param", "error": str(error)})
        except Exception:
            send({"id": job.get("id"), "ok": False, "kind": "infer", "error": traceback.format_exc()[-1500:]})
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
