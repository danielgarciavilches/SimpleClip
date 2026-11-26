"""'Even out voices': split the sound into voices and game with an AI vocal model
(UVR MDX-Net, Kim_Vocal_2.onnx, runs offline on the CPU), then level the voices so
everyone in the call ends up at a similar volume. The game is left untouched.
"""

import os
import subprocess

import numpy as np

SR = 44100  # the model works at 44.1 kHz
N_FFT, HOP, DIM_F, DIM_T = 7680, 1024, 3072, 256
N_BINS = N_FFT // 2 + 1
TRIM = N_FFT // 2
CHUNK = HOP * (DIM_T - 1)
GEN = CHUNK - 2 * TRIM
WINDOW = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float32)

# Slow, gentle leveler on the voices only: ~4 s window, so each person's talking level
# is matched but a single laugh isn't flattened. Frames below -40 dB are left alone.
LEVELER = 'dynaudnorm=f=250:g=15:p=0.9:m=10:t=0.01'


class Cancelled(Exception):
    pass


def _stft(x):
    """(2, CHUNK) -> (4, DIM_F, DIM_T), same layout as torch.stft(center=True) in UVR."""
    padded = np.pad(x, ((0, 0), (N_FFT // 2, N_FFT // 2)), mode='reflect')
    idx = np.arange(DIM_T)[:, None] * HOP + np.arange(N_FFT)[None, :]
    spec = np.fft.rfft(padded[:, idx] * WINDOW, axis=-1).transpose(0, 2, 1)
    out = np.stack([spec.real, spec.imag], axis=1)
    return out.reshape(4, N_BINS, DIM_T)[:, :DIM_F].astype(np.float32)


def _istft(s):
    full = np.zeros((4, N_BINS, DIM_T), np.float32)
    full[:, :DIM_F] = s
    full = full.reshape(2, 2, N_BINS, DIM_T)
    spec = (full[:, 0] + 1j * full[:, 1]).transpose(0, 2, 1)
    frames = np.fft.irfft(spec, n=N_FFT, axis=-1) * WINDOW
    length = N_FFT + HOP * (DIM_T - 1)
    y = np.zeros((2, length))
    norm = np.zeros(length)
    for t in range(DIM_T):
        y[:, t * HOP:t * HOP + N_FFT] += frames[:, t]
        norm[t * HOP:t * HOP + N_FFT] += WINDOW ** 2
    return (y / np.maximum(norm, 1e-8))[:, N_FFT // 2:N_FFT // 2 + CHUNK]


def _separate(mix, session, progress, cancelled):
    n = mix.shape[1]
    pad = GEN - n % GEN
    padded = np.concatenate([np.zeros((2, TRIM)), mix, np.zeros((2, pad)), np.zeros((2, TRIM))], axis=1)
    starts = range(0, n + pad, GEN)
    pieces = []
    for k, i in enumerate(starts):
        if cancelled():
            raise Cancelled()
        spec = _stft(padded[:, i:i + CHUNK])[None]
        # UVR's "denoise": average the model on the spectrum and its negative.
        a = session.run(None, {'input': spec})[0]
        b = session.run(None, {'input': -spec})[0]
        pieces.append(_istft(((a - b) * 0.5)[0])[:, TRIM:-TRIM])
        progress((k + 1) / len(starts))
    return np.concatenate(pieces, axis=1)[:, :n].astype(np.float32)


def analyze(ffmpeg, model_path, src, start, end, out_dir, progress=lambda p: None,
            cancelled=lambda: False, no_window=0):
    """Writes <out_dir>/voices.wav (leveled voices) and game.wav for src[start:end].
    Returns their paths."""
    import onnxruntime as ort  # imported late: it's big and only needed here

    raw = subprocess.run([ffmpeg, '-v', 'error', '-ss', f'{start:.6f}', '-i', src, '-t', f'{end - start:.6f}',
                          '-map', '0:a:0', '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True, creationflags=no_window).stdout
    mix = np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy()
    progress(0.02)
    session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
    voices = _separate(mix, session, lambda p: progress(0.02 + 0.9 * p), cancelled)
    game = mix - voices

    os.makedirs(out_dir, exist_ok=True)
    voices_path, game_path = os.path.join(out_dir, 'voices.wav'), os.path.join(out_dir, 'game.wav')
    for data, path, flt in ((voices, voices_path, LEVELER), (game, game_path, None)):
        subprocess.run([ffmpeg, '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-',
                        *(['-af', flt] if flt else []), '-c:a', 'pcm_s16le', path],
                       input=np.ascontiguousarray(data.T).tobytes(), check=True, creationflags=no_window)
    progress(1.0)
    return voices_path, game_path
