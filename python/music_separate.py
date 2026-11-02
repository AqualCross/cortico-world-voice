"""demucs-onnx 0.3.4：使用预先获取的本地 ONNX 权重，输出人声与伴奏。"""
import argparse
import os
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', required=True)
    parser.add_argument('--code', required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    args = parser.parse_args()
    sys.path.insert(0, os.path.join(os.path.abspath(args.code), 'src'))
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    from demucs_onnx import load_audio
    # 固定到 0.3.4 的分块推理接口；直接传本地模型，推理期间不访问 Hub。
    from demucs_onnx.inference import SOURCES, _chunked_separate_single

    model = Path(args.models) / 'htdemucs_fp16weights.onnx'
    if not model.is_file():
        parser.error('先在「依赖」页获取 Demucs ONNX 权重。')
    providers = ['CPUExecutionProvider']
    if args.device == 'cuda':
        # pip 装的 CUDA / cuDNN 运行库在 site-packages/nvidia 下，ORT 不会自己找。
        try:
            ort.preload_dlls()
        except Exception as error:
            print(f'预载 CUDA 运行库失败：{error}', flush=True)
        for gpu in ['CUDAExecutionProvider', 'DmlExecutionProvider']:
            if gpu in ort.get_available_providers():
                providers.insert(0, gpu)
                break
        if providers[0] == 'CPUExecutionProvider':
            print('ONNX: 没有可用的显卡执行器，改用 CPU', flush=True)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    if providers[0] == 'DmlExecutionProvider':
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    try:
        session = ort.InferenceSession(str(model), sess_options=options, providers=providers)
    except Exception as error:
        if providers[0] == 'CPUExecutionProvider':
            raise
        # 驱动或运行库不齐时不让整个分离失败，退回 CPU 并说明原因。
        print(f'ONNX: {providers[0]} 起不来，改用 CPU（{error}）', flush=True)
        session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
    print('ONNX: ' + session.get_providers()[0], flush=True)
    try:
        mix, _ = load_audio(args.input)
    except (RuntimeError, sf.LibsndfileError):
        # SoundFile 无法解码的容器（如 M4A）交给已获取的 FFmpeg。
        decoded = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', args.input,
                                  '-ac', '2', '-ar', '44100', '-f', 'f32le', 'pipe:1'],
                                 capture_output=True, check=True)
        mix = np.frombuffer(decoded.stdout, dtype='<f4').reshape(-1, 2).T.copy()
    if not mix.shape[1]:
        parser.error('音频为空。')
    stems = _chunked_separate_single(session, SOURCES, mix, verbose=True, progress=False)
    output = Path(args.output) / 'htdemucs'
    output.mkdir(parents=True, exist_ok=True)
    sf.write(output / 'vocals.wav', stems['vocals'].T, 44100, subtype='FLOAT')
    accompaniment = stems['drums'] + stems['bass'] + stems['other']
    sf.write(output / 'no_vocals.wav', accompaniment.T, 44100, subtype='FLOAT')
    print('分离完成', flush=True)


if __name__ == '__main__':
    main()
