"""SimpleClip - a tiny portable video trimmer.

Backend: a local HTTP server streams the video to the UI (with Range support so
seeking works) and ffmpeg does the actual cutting. The portable app keeps its
settings next to the executable so it can run from a USB stick; the Microsoft
Store version keeps them in the user's app data, because its folder is read-only.
"""

import ctypes
import json
import math
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

import webview
from webview.dom import DOMEventHandler

APP_NAME = 'SimpleClip'
VIDEO_EXTS = ('.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi')
NO_WINDOW = 0x08000000 if os.name == 'nt' else 0

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
    UI_DIR = os.path.join(sys._MEIPASS, 'ui')
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    UI_DIR = os.path.join(BASE_DIR, 'ui')


def installed_from_package():
    """True when Windows runs the app from an MSIX package (the Microsoft Store version)."""
    if os.name != 'nt':
        return False
    try:
        length = ctypes.c_uint32(0)
        # Returns APPMODEL_ERROR_NO_PACKAGE (15700) for an ordinary, unpackaged program.
        return ctypes.windll.kernel32.GetCurrentPackageFullName(ctypes.byref(length), None) != 15700
    except (AttributeError, OSError):  # Windows older than 8 has no packages
        return False


PACKAGED = installed_from_package()
# A package's install folder is read-only. Windows keeps AppData writes of a packaged app in
# the package's own storage and removes them when the app is uninstalled.
DATA_DIR = (os.path.join(os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), APP_NAME)
            if PACKAGED else BASE_DIR)
SETTINGS_PATH = os.path.join(DATA_DIR, 'settings.json')
DEFAULT_SETTINGS = {
    'default_folder': '',
    'always_ask': False,
    'mode': 'lossless',
    'reveal_after_export': True,
    'suffix': '_clip',
}
PROXY_DIR = os.path.join(tempfile.gettempdir(), 'SimpleClipPreview')
VOICES_DIR = os.path.join(tempfile.gettempdir(), 'SimpleClipVoices')


def find_tool(name):
    exe = name + ('.exe' if os.name == 'nt' else '')
    for folder in (os.path.join(BASE_DIR, 'bin'), BASE_DIR, os.path.join(BASE_DIR, '..', 'bin')):
        candidate = os.path.abspath(os.path.join(folder, exe))
        if os.path.isfile(candidate):
            return candidate
    return shutil.which(name)


FFMPEG = find_tool('ffmpeg')
FFPROBE = find_tool('ffprobe')
VOICE_MODEL = next((p for p in (os.path.join(BASE_DIR, 'models', 'Kim_Vocal_2.onnx'),
                                os.path.join(BASE_DIR, '..', 'models', 'Kim_Vocal_2.onnx'))
                    if os.path.isfile(p)), None)


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, encoding='utf-8',
                          errors='replace', creationflags=NO_WINDOW, **kw)


# --------------------------------------------------------------------------- settings

def load_settings():
    settings = dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_PATH, 'r', encoding='utf-8') as f:
            settings.update(json.load(f))
    except (OSError, ValueError):
        pass
    return settings


def save_settings(settings):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(SETTINGS_PATH, 'w', encoding='utf-8') as f:
            json.dump(settings, f, indent=2)
    except OSError:
        pass


def portable_path(path):
    """Store folders on the app's own drive as relative paths so they survive the
    USB stick getting a different drive letter on another computer. The Store version keeps
    full paths: its install folder name changes with every update."""
    path = os.path.abspath(path)
    if PACKAGED:
        return path
    if os.path.splitdrive(path)[0].lower() == os.path.splitdrive(BASE_DIR)[0].lower():
        return os.path.relpath(path, BASE_DIR)
    return path


def resolve_path(path):
    if not path:
        return ''
    return os.path.normpath(path if os.path.isabs(path) else os.path.join(BASE_DIR, path))


# --------------------------------------------------------------------------- media server

class MediaRegistry:
    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}       # token -> path
        self.active = {}      # path -> number of open streams
        self.blocked = set()  # paths that must not be opened (about to be replaced)
        self.counter = 0

    def register(self, path):
        with self.lock:
            self.counter += 1
            token = str(self.counter)
            self.items[token] = path
            return token

    def wait_idle(self, path, timeout=5.0):
        with self.lock:
            self.blocked.add(path)
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                if not self.active.get(path):
                    return True
            time.sleep(0.05)
        return False

    def unblock(self, path):
        with self.lock:
            self.blocked.discard(path)


MEDIA = MediaRegistry()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith('/media/'):
            return self.serve_media(url.path[len('/media/'):])
        rel = unquote(url.path).lstrip('/') or 'index.html'
        full = os.path.normpath(os.path.join(UI_DIR, rel))
        if not full.startswith(os.path.normpath(UI_DIR)) or not os.path.isfile(full):
            return self.send_error(404)
        with open(full, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(full)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def serve_media(self, token):
        path = MEDIA.items.get(token)
        with MEDIA.lock:
            if not path or path in MEDIA.blocked or not os.path.isfile(path):
                return self.send_error(404)
            MEDIA.active[path] = MEDIA.active.get(path, 0) + 1
        try:
            size = os.path.getsize(path)
            start, end = 0, size - 1
            match = re.match(r'bytes=(\d*)-(\d*)', self.headers.get('Range', ''))
            if match:
                if match.group(1):
                    start = int(match.group(1))
                    if match.group(2):
                        end = min(int(match.group(2)), size - 1)
                elif match.group(2):
                    start = max(0, size - int(match.group(2)))
                self.send_response(206)
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            else:
                self.send_response(200)
            ext = os.path.splitext(path)[1].lower()
            ctype = {'.webm': 'video/webm', '.mkv': 'video/webm', '.wav': 'audio/wav'}.get(ext, 'video/mp4')
            self.send_header('Content-Type', ctype)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            with open(path, 'rb') as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    if path in MEDIA.blocked:
                        break
                    chunk = f.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (ConnectionError, OSError):
            pass
        finally:
            with MEDIA.lock:
                MEDIA.active[path] -= 1


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # the player aborts range requests all the time while seeking


def start_server():
    server = QuietServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


# --------------------------------------------------------------------------- ffmpeg helpers

def probe(path):
    result = run([FFPROBE, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or 'Could not read this file.')
    data = json.loads(result.stdout)
    fmt = data.get('format', {})
    streams = data.get('streams', [])
    video = next((s for s in streams if s.get('codec_type') == 'video'
                  and not s.get('disposition', {}).get('attached_pic')), None)
    audio = [s for s in streams if s.get('codec_type') == 'audio']
    duration = float(fmt.get('duration') or (video or {}).get('duration') or 0)
    fps = 0.0
    if video and video.get('avg_frame_rate', '0/0') != '0/0':
        num, den = video['avg_frame_rate'].split('/')
        fps = float(num) / float(den) if float(den) else 0.0
    bit_rate = int(fmt.get('bit_rate') or 0)
    audio_bitrate = sum(int(a.get('bit_rate') or 0) for a in audio)
    # MKV/WEBM don't store per-stream bitrates: derive the video one from the total.
    video_bitrate = int((video or {}).get('bit_rate') or 0) or max(0, bit_rate - audio_bitrate)
    return {
        'path': path,
        'name': os.path.basename(path),
        'folder': os.path.dirname(path),
        'size': int(fmt.get('size') or os.path.getsize(path)),
        'duration': duration,
        'video_codec': (video or {}).get('codec_name', ''),
        'width': (video or {}).get('width', 0),
        'height': (video or {}).get('height', 0),
        'fps': round(fps, 3),
        'audio_codec': audio[0].get('codec_name', '') if audio else '',
        'sample_rate': int(audio[0].get('sample_rate') or 48000) if audio else 48000,
        'audio_tracks': len(audio),
        'has_video': video is not None,
        'bit_rate': bit_rate,
        'video_bitrate': video_bitrate,
        'audio_bitrate': audio_bitrate,
    }


def keyframes(path):
    result = run([FFPROBE, '-v', 'error', '-select_streams', 'v:0',
                  '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path])
    times = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(',')
        if len(parts) >= 2 and 'K' in parts[1]:
            try:
                times.append(float(parts[0]))
            except ValueError:
                pass
    return sorted(times)


# quality -> (x264 CRF, max share of the source video bitrate, AAC bitrate).
# The bitrate cap keeps a re-encoded clip from ever being bigger than the original.
QUALITY = {
    'original': (17, 1.0, '320k'),
    'high': (20, 0.7, '320k'),
    'balanced': (23, 0.45, '192k'),
    'small': (27, 0.25, '128k'),
}
LOUDNESS_TARGET = -14.0  # LUFS, what YouTube & co. normalize to
PEAK_CEILING = -1.0      # dBTP, keep the loudest peak below this so it never distorts
MAX_VOLUME = 5.0         # volume slider maximum (500%)


def audio_encoder_args(codec, ext, quality='original'):
    if codec.startswith('pcm_'):
        return ['-c:a', codec]
    if codec == 'flac' and ext in ('.mkv', '.mov'):
        return ['-c:a', 'flac']
    if ext == '.webm' or (codec == 'opus' and ext == '.mkv'):
        return ['-c:a', 'libopus', '-b:a', '256k' if quality in ('original', 'high') else '128k']
    return ['-c:a', 'aac', '-b:a', QUALITY[quality][2]]


def video_encoder_args(codec, ext, quality, source_bitrate, height):
    crf, share, _ = QUALITY[quality]
    cap = int(source_bitrate * share)
    if ext == '.webm':
        args = ['-c:v', 'libvpx-vp9', '-crf', str(crf + 14), '-b:v', str(cap or 0), '-row-mt', '1']
    elif codec == 'hevc':
        args = ['-c:v', 'libx265', '-crf', str(crf + 3), '-preset', 'medium', '-x265-params', 'log-level=error']
        args += ['-tag:v', 'hvc1'] if ext in ('.mp4', '.mov', '.m4v') else []
    else:
        args = ['-c:v', 'libx264', '-crf', str(crf), '-preset', 'medium']
    if cap and ext != '.webm':
        args += ['-maxrate', str(cap), '-bufsize', str(cap * 2)]
    if quality == 'small' and height > 1080:
        args += ['-vf', 'scale=-2:1080']
    return args


def dynamics_filters(tame, boost):
    """The optional loud/quiet controls as ffmpeg compressors.
    Keep in sync with dynamicsStages() in ui/app.js, which previews the same math."""
    filters = []
    if tame > 0:  # pull peaks such as laughs down
        thr = 10 ** ((-10 - 14 * tame) / 20)
        filters.append(f'acompressor=threshold={thr:.6f}:ratio={2 + 4 * tame:.3f}:attack=5:release=120'
                       ':knee=1:detection=rms:link=average')
    if boost > 0:  # lift quiet parts, leave loud parts alone (upward compression)
        thr = 10 ** (-32 / 20)
        filters.append(f'acompressor=mode=upward:threshold={thr:.6f}:ratio={1 + 3 * boost:.3f}'
                       ':attack=20:release=300:knee=1:detection=rms:link=average')
    return filters


def voices_inputs(stems, start, duration):
    """ffmpeg inputs for the analyzed voices/game tracks, lined up with src[start:start+duration]."""
    offset = f'{max(0.0, start - stems["start"]):.6f}'
    return ['-ss', offset, '-t', f'{duration:.6f}', '-i', stems['voices'],
            '-ss', offset, '-t', f'{duration:.6f}', '-i', stems['game']]


def voices_mix(voices_index, game_index, voices_db, game_db):
    """Filter that mixes the (already leveled) voices with the game, as the preview does."""
    return (f'[{voices_index}:a]volume={float(voices_db):.2f}dB[vv];'
            f'[{game_index}:a]volume={float(game_db):.2f}dB[gg];'
            f'[vv][gg]amix=inputs=2:normalize=0:duration=longest')


def stems_cover(stems, start, end):
    return stems is not None and start >= stems['start'] - 0.05 and end <= stems['end'] + 0.05


def run_ffmpeg(args, duration, on_progress):
    """Runs ffmpeg reporting 0..1 progress; returns (ok, error_text)."""
    proc = subprocess.Popen([FFMPEG, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
                             '-progress', 'pipe:1', '-nostats'] + args,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding='utf-8', errors='replace', creationflags=NO_WINDOW)
    err_lines = []
    t = threading.Thread(target=lambda: err_lines.extend(proc.stderr), daemon=True)
    t.start()
    for line in proc.stdout:
        if line.startswith('out_time_us=') and duration > 0:
            try:
                on_progress(max(0.0, min(1.0, int(line.split('=')[1]) / 1e6 / duration)))
            except ValueError:
                pass
    proc.wait()
    t.join(timeout=2)
    return proc.returncode == 0, ''.join(err_lines).strip()


def unique_path(folder, stem, ext):
    candidate = os.path.join(folder, stem + ext)
    n = 2
    while os.path.exists(candidate):
        candidate = os.path.join(folder, f'{stem} ({n}){ext}')
        n += 1
    return candidate


# --------------------------------------------------------------------------- API exposed to JS

class Api:
    def __init__(self):
        self._window = None
        self._settings = load_settings()
        self._busy = False
        self._keyframes = {}
        self._stems = {}  # path -> analyzed voices/game tracks (see analyze_voices)
        self._cancel_voices = False

    def _js(self, fn, *args):
        if self._window:
            self._window.evaluate_js(f'{fn}({",".join(json.dumps(a) for a in args)})')

    # ---- startup / settings
    def init(self):
        s = dict(self._settings)
        s['default_folder_resolved'] = resolve_path(s['default_folder'])
        return {
            'settings': s,
            'ffmpeg_ok': bool(FFMPEG and FFPROBE),
            'voices_ok': bool(VOICE_MODEL),
            'startup_file': next((a for a in sys.argv[1:] if os.path.isfile(a)), None),
        }

    def update_settings(self, changes):
        for key in ('always_ask', 'mode', 'reveal_after_export', 'suffix'):
            if key in changes:
                self._settings[key] = changes[key]
        save_settings(self._settings)
        return self.init()['settings']

    def choose_default_folder(self):
        result = self._window.create_file_dialog(webview.FileDialog.FOLDER,
                                                directory=resolve_path(self._settings['default_folder']))
        if result:
            self._settings['default_folder'] = portable_path(result[0])
            save_settings(self._settings)
        return self.init()['settings']

    def set_default_folder(self, folder):
        self._settings['default_folder'] = portable_path(folder) if folder else ''
        save_settings(self._settings)
        return self.init()['settings']

    # ---- opening files
    def browse(self):
        types = ('Video files (*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi)', 'All files (*.*)')
        result = self._window.create_file_dialog(webview.FileDialog.OPEN, file_types=types)
        if result:
            return self.open_file(result[0])
        return None

    def open_file(self, path):
        if not (FFMPEG and FFPROBE):
            return {'error': 'ffmpeg.exe / ffprobe.exe were not found in the "bin" folder next to the app.'}
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            return {'error': 'File not found.'}
        try:
            info = probe(path)
        except Exception as e:  # noqa: BLE001
            return {'error': f'Could not open this file as a video.\n{e}'}
        if not info['has_video'] or info['duration'] <= 0:
            return {'error': 'This file does not seem to contain a video stream.'}
        MEDIA.unblock(path)
        info['url'] = '/media/' + MEDIA.register(path)
        threading.Thread(target=self._load_keyframes, args=(path,), daemon=True).start()
        return info

    def _load_keyframes(self, path):
        kf = keyframes(path)
        self._keyframes[path] = kf
        self._js('window.onKeyframes', path, kf)

    def make_preview(self, path):
        """For codecs the built-in player can't decode (e.g. HEVC / iPhone videos)
        create a light H.264 proxy used only for previewing. Exports always use the
        original file."""
        os.makedirs(PROXY_DIR, exist_ok=True)
        info = probe(path)
        out = os.path.join(PROXY_DIR, f'preview_{time.time_ns()}.mp4')
        ok, err = run_ffmpeg(['-i', path, '-map', '0:v:0', '-map', '0:a:0?',
                              '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'ultrafast',
                              '-crf', '26', '-g', '12', '-pix_fmt', 'yuv420p',
                              '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out],
                             info['duration'], lambda p: self._js('window.onPreviewProgress', p))
        if not ok:
            return {'error': err or 'Could not create a preview.'}
        return {'url': '/media/' + MEDIA.register(out)}

    # ---- exporting
    def pick_export_folder(self, start_dir):
        result = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=start_dir or '')
        return result[0] if result else None

    # ---- even out voices
    def analyze_voices(self, path, start, end):
        """Separate voices from game for src[start:end] (plus a little margin) and level them.
        Returns URLs of the two tracks for the live preview."""
        if not VOICE_MODEL:
            return {'error': 'The voice model (models\\Kim_Vocal_2.onnx) is missing next to the app.'}
        # Imported late: numpy makes the first start slower and is only needed here.
        import voices
        info = probe(path)
        if not info['audio_tracks']:
            return {'error': 'This video has no sound.'}
        start, end = max(0.0, float(start) - 1), min(info['duration'], float(end) + 1)
        self._cancel_voices = False
        out_dir = os.path.join(VOICES_DIR, str(time.time_ns()))
        try:
            voices_path, game_path = voices.analyze(
                FFMPEG, VOICE_MODEL, path, start, end, out_dir,
                progress=lambda p: self._js('window.onVoicesProgress', p),
                cancelled=lambda: self._cancel_voices, no_window=NO_WINDOW)
        except voices.Cancelled:
            shutil.rmtree(out_dir, ignore_errors=True)
            return {'cancelled': True}
        except Exception as e:  # noqa: BLE001
            shutil.rmtree(out_dir, ignore_errors=True)
            return {'error': f'Could not analyze the voices.\n{e}'}
        old = self._stems.get(path)
        if old:
            shutil.rmtree(old['dir'], ignore_errors=True)
        self._stems[path] = {'start': start, 'end': end, 'dir': out_dir, 'voices': voices_path, 'game': game_path}
        return {'start': start, 'end': end,
                'voices_url': '/media/' + MEDIA.register(voices_path),
                'game_url': '/media/' + MEDIA.register(game_path)}

    def cancel_voices(self):
        self._cancel_voices = True
        return True

    def forget_voices(self, path):
        old = self._stems.pop(path, None)
        if old:
            shutil.rmtree(old['dir'], ignore_errors=True)
        return True

    # ---- audio
    def measure_loudness(self, path, start, end, tame=0.0, boost=0.0, voices_opts=None):
        """How much to turn the selection up/down to reach internet loudness (-14 LUFS).
        Plain gain only: the whole clip moves together, so loud moments stay louder.
        Even-out-voices and the loud/quiet controls are applied first so the result
        matches the export."""
        start, end = float(start), float(end)
        duration = max(0.05, end - start)
        chain = dynamics_filters(float(tame), float(boost))
        chain.append(f'loudnorm=I={LOUDNESS_TARGET}:TP={PEAK_CEILING}:LRA=20:print_format=json')
        stems = self._stems.get(path)
        if voices_opts and stems_cover(stems, start, end):
            graph = voices_mix(0, 1, voices_opts['voices_db'], voices_opts['game_db']) + ',' + ','.join(chain)
            cmd = [FFMPEG, '-hide_banner', '-nostdin', *voices_inputs(stems, start, duration),
                   '-filter_complex', graph, '-f', 'null', '-']
        else:
            cmd = [FFMPEG, '-hide_banner', '-nostdin', '-ss', f'{start:.6f}', '-i', path,
                   '-t', f'{duration:.6f}', '-map', '0:a:0', '-af', ','.join(chain), '-f', 'null', '-']
        result = run(cmd)
        try:
            stats = json.loads(result.stderr[result.stderr.rindex('{'):result.stderr.rindex('}') + 1])
            loudness, peak = float(stats['input_i']), float(stats['input_tp'])
        except (ValueError, KeyError):
            return {'error': 'Could not measure the volume of this clip.'}
        if loudness == float('-inf') or loudness < -70:
            return {'error': 'The selected part is silent.'}
        wanted = LOUDNESS_TARGET - loudness
        gain = min(wanted, PEAK_CEILING - peak)  # never push the loudest peak into distortion
        gain = max(-60.0, min(gain, 20 * math.log10(MAX_VOLUME)))
        return {
            'gain_db': round(gain, 2),
            'volume': round(10 ** (gain / 20), 4),
            'loudness': round(loudness, 1),
            'result_loudness': round(loudness + gain, 1),
            'limited_by_peak': gain < wanted - 0.1,
        }

    def export(self, opts):
        """opts: path, start, end, volume (1.0 = unchanged), mode, quality, tame, boost,
        target ('copy'|'replace'), folder."""
        if self._busy:
            return {'error': 'An export is already running.'}
        self._busy = True
        try:
            return self._export(opts)
        finally:
            self._busy = False

    def _export(self, opts):
        src = opts['path']
        info = probe(src)
        ext = os.path.splitext(src)[1].lower()
        requested_start = start = float(opts['start'])
        end = float(opts['end'])
        volume = float(opts.get('volume', 1.0))
        quality = opts.get('quality', 'original')
        if quality not in QUALITY:
            quality = 'original'
        # Making the file smaller means re-encoding, which is always frame-exact.
        lossless = opts.get('mode', 'lossless') == 'lossless' and quality == 'original'
        has_audio = info['audio_tracks'] > 0
        audio_filters = dynamics_filters(float(opts.get('tame', 0)), float(opts.get('boost', 0)))
        if abs(volume - 1.0) > 0.001:
            audio_filters.append(f'volume={volume:.4f}')
        voices_opts = opts.get('voices') if has_audio else None
        process_audio = has_audio and (bool(audio_filters) or bool(voices_opts))

        if lossless and start > 0.001:
            kf = self._keyframes.get(src) or keyframes(src)
            before = [k for k in kf if k <= start + 0.001]
            if before:
                start = before[-1]
        if end - start < 0.05:
            return {'error': 'The selection is too short.'}
        duration = end - start
        stems = self._stems.get(src) if voices_opts else None
        if voices_opts and not stems_cover(stems, start, end):
            return {'error': 'The voice analysis doesn’t cover this part of the video anymore '
                             '(the trim changed). Click “Analyze again” in the Sound panel.'}

        if opts['target'] == 'replace':
            out = os.path.join(os.path.dirname(src),
                               f'.{os.path.splitext(os.path.basename(src))[0]}.clipping{ext}')
        else:
            folder = opts.get('folder')
            if not folder:
                return {'error': 'No output folder chosen.'}
            os.makedirs(folder, exist_ok=True)
            stem = os.path.splitext(os.path.basename(src))[0] + (self._settings.get('suffix') or '')
            out = unique_path(folder, stem, ext)

        # Seeking: with stream copy ffmpeg starts at the keyframe we picked above
        # (tiny offset so float rounding never jumps to the previous keyframe).
        args = ['-ss', f'{start + (0.001 if lossless and start > 0 else 0):.6f}', '-i', src]
        if stems:
            # Sound = analyzed voices + game (inputs 1 and 2) instead of the original track.
            graph = voices_mix(1, 2, voices_opts['voices_db'], voices_opts['game_db'])
            graph += ''.join(',' + f for f in audio_filters) + f',aresample={info["sample_rate"]}[aout]'
            args += voices_inputs(stems, start, duration)
            args += ['-filter_complex', graph, '-t', f'{duration:.6f}', '-map', '0:v', '-map', '[aout]']
        else:
            args += ['-t', f'{duration:.6f}', '-map', '0:v', '-map', '0:a?']
        args += ['-map_metadata', '0', '-ignore_unknown']
        if lossless:
            args += ['-c:v', 'copy']
        else:
            args += video_encoder_args(info['video_codec'], ext, quality,
                                       info['video_bitrate'], info['height'])
        # Copied audio would start at the keyframe too, so frame-exact cuts must
        # re-encode audio as well to stay in sync with the exact video start.
        if process_audio and not stems:
            args += ['-filter:a', ','.join(audio_filters)]
        if process_audio or (not lossless and has_audio):
            args += audio_encoder_args(info['audio_codec'], ext, quality)
        else:
            args += ['-c:a', 'copy']
        if ext in ('.mp4', '.mov', '.m4v'):
            args += ['-movflags', '+faststart']
        args += ['-avoid_negative_ts', 'make_zero', out]

        ok, err = run_ffmpeg(args, duration, lambda p: self._js('window.onExportProgress', p))
        if not ok:
            try:
                os.remove(out)
            except OSError:
                pass
            return {'error': err or 'ffmpeg failed.'}

        if opts['target'] == 'replace':
            MEDIA.wait_idle(src)
            last_error = None
            for _ in range(40):
                try:
                    os.replace(out, src)
                    last_error = None
                    break
                except OSError as e:
                    last_error = e
                    time.sleep(0.25)
            MEDIA.unblock(src)
            if last_error:
                try:
                    os.remove(out)
                except OSError:
                    pass
                return {'error': f'Could not replace the original file (is it open in another program?)\n{last_error}'}
            out = src
            self.forget_voices(src)  # the sound is baked in now

        if self._settings.get('reveal_after_export') and opts['target'] != 'replace':
            self.reveal(out)
        try:
            real_duration = probe(out)['duration'] or duration
        except Exception:  # noqa: BLE001
            real_duration = duration
        return {'ok': True, 'output': out, 'start': start, 'requested_start': requested_start,
                'duration': real_duration, 'size': os.path.getsize(out), 'source_size': info['size']}

    def release(self, path):
        """Called by the UI right before replacing: stop serving the original file."""
        MEDIA.wait_idle(path, timeout=0.5)
        return True

    def reveal(self, path):
        if os.name == 'nt':
            subprocess.Popen(['explorer', '/select,', os.path.normpath(path)], creationflags=NO_WINDOW)
        return True

    def open_folder(self, folder):
        if os.path.isdir(folder) and os.name == 'nt':
            os.startfile(folder)
        return True


# --------------------------------------------------------------------------- main

def self_test(report_path):
    """SimpleClip.exe --self-test <report.txt>: checks ffmpeg and the voice model work
    on this PC without opening a window (handy when something fails on another computer)."""
    lines = [f'ffmpeg: {FFMPEG}', f'ffprobe: {FFPROBE}', f'voice model: {VOICE_MODEL}',
             f'Microsoft Store version: {PACKAGED}']
    probe = os.path.join(DATA_DIR, 'self-test.tmp')
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(probe, 'w', encoding='utf-8') as f:
            f.write('ok')
        lines.append(f'settings folder: {DATA_DIR} (can save)')
    except OSError as e:
        lines.append(f'settings folder: {DATA_DIR} (CANNOT SAVE - {e})')
    finally:
        try:
            os.remove(probe)
        except OSError:
            pass
    work = os.path.join(VOICES_DIR, 'self-test')
    try:
        import voices
        os.makedirs(work, exist_ok=True)
        tone = os.path.join(work, 'tone.wav')
        run([FFMPEG, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=4', '-ac', '2', tone])
        start = time.time()
        voices_path, game_path = voices.analyze(FFMPEG, VOICE_MODEL, tone, 0, 4, work, no_window=NO_WINDOW)
        lines.append(f'voice separation: OK in {time.time() - start:.1f}s '
                     f'({os.path.getsize(voices_path)} + {os.path.getsize(game_path)} bytes)')
    except Exception as e:  # noqa: BLE001
        lines.append(f'voice separation: FAILED - {e!r}')
    finally:
        shutil.rmtree(work, ignore_errors=True)
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == '--self-test':
        return self_test(sys.argv[2])
    api = Api()
    port = start_server()
    try:
        screen = webview.screens[0]
        width, height = min(1180, screen.width - 60), min(780, screen.height - 90)
    except Exception:  # noqa: BLE001
        width, height = 1180, 760
    window = webview.create_window(APP_NAME, f'http://127.0.0.1:{port}/index.html', js_api=api,
                                   width=width, height=height, min_size=(820, 560),
                                   background_color='#141319')
    api._window = window

    def on_drop(event):
        files = event.get('dataTransfer', {}).get('files', [])
        paths = [f.get('pywebviewFullPath') for f in files if f.get('pywebviewFullPath')]
        if paths:
            api._js('window.onFileDropped', paths[0])

    def on_loaded():
        window.dom.document.events.drop += DOMEventHandler(on_drop, True, True)

    window.events.loaded += on_loaded
    webview.start(private_mode=True)
    shutil.rmtree(PROXY_DIR, ignore_errors=True)
    shutil.rmtree(VOICES_DIR, ignore_errors=True)


if __name__ == '__main__':
    main()
