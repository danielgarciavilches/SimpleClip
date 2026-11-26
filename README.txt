SIMPLECLIP  -  portable video trimmer
======================================

Run SimpleClip.exe. Nothing to install - copy this whole folder to a USB
stick and it works on any Windows 10/11 PC.

The first start can take up to a minute, because Windows checks the new
files. After that it opens in a couple of seconds.

  1. Drop a video on the window (or click to browse). MP4, MOV, MKV, WEBM.
  2. Drag the violet handles on the timeline, or type exact times, or press
     I / O to set start / end at the playhead.
  3. Adjust the volume (0-500%), or click "Auto volume". You hear every
     change while previewing.
  4. "Save as new clip" or "Replace original". After saving, the app tells
     you the real length and size of the new file.

Hover over any button with a "?" or an explanation for details.

Modes
  Lossless     Copies the original video data untouched - zero quality loss,
               takes a second or two. The clip can only start on a keyframe
               (the app shows you exactly where, usually within ~1-2 s).
  Frame-exact  Starts on the exact frame you picked. The video is re-encoded
               at very high quality (visually identical, but slower).

  If a video has keyframes far apart (some game recorders), a lossless clip
  can start many seconds early. The app warns you in orange and shades the
  extra part on the timeline before you save.

File size
  Original quality (default) keeps everything. High / Balanced / Small make
  the file smaller by re-processing the video (smaller = more quality lost;
  Small also shrinks anything above 1080p to 1080p). This always cuts
  frame-exact.

Sound
  Auto volume   Sets the clip to the standard internet loudness (about
                -14 LUFS, what YouTube uses). The whole clip moves up or down
                together, so laughs stay louder than the rest. If boosting
                would make the loudest moment distort, it stops just before.
  Sound button  Optional tools, all off by default:
    Even out voices   An AI model (offline, on this PC) separates the voices
                      from the game, then evens the voices out so everyone in
                      the call is about equally loud. The game is untouched;
                      laughs stay louder than normal talking. Click "Analyze &
                      even out voices" (takes about as long as the clip), then
                      press play to hear it. Optional Voices / Game sliders.
                      If you later trim outside the analyzed part, click
                      "Analyze again".
    Tame loud parts   Brings down laughs/screams that blast the listener.
    Boost quiet parts Brings up quiet sound (raises quiet game sounds too).
  Auto volume takes all of these into account.

  If the sound is left untouched (100%, loud/quiet off) it is copied
  untouched. Otherwise only the sound is re-processed (AAC 320 kbps, or the
  original codec for uncompressed audio). The picture stays lossless.

Settings (gear icon)
  Default export folder - set it once and you won't be asked again. Folders on
  the same drive as the app are stored relative to it, so they keep working
  when the USB stick gets a different drive letter.
  Settings are saved in settings.json next to the .exe.

Shortcuts
  Space play/pause | I / O set start/end | Left/Right one frame (Shift = 1 s)
  Home / End jump to selection start/end | Ctrl+O open

Folder contents
  SimpleClip.exe   the app
  SimpleClip.exe.config   needed by the app (don't delete)
  _internal\         app runtime (don't delete)
  bin\ffmpeg.exe, bin\ffprobe.exe   the cutting engine (FFmpeg, GPL build from gyan.dev)
  models\Kim_Vocal_2.onnx           the voice-separation AI (from the Ultimate
                                    Vocal Remover project, by Kimberley Jensen)

Troubleshooting
  If you see "Failed to load Python DLL ... Access is denied" right after
  unzipping, wait a few minutes and open the app again. Antivirus software may
  still be checking the files.

  If "Even out voices" fails on some PC, run this in a terminal in this folder:
      SimpleClip.exe --self-test report.txt
  and look at report.txt.
