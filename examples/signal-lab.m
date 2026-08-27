% exported by ReRun — cells in dependency order, runs top-to-bottom
%
% Signal Lab demo. This version synthesizes a test tone so it's runnable
% standalone; click "🎵 audio" in the ReRun header and drop a real audio or
% video file (any format — ffmpeg.wasm decodes it) to replace cell 1 with
% [x, fs] = audioread('input.wav') on real samples instead. "💾 export
% audio" writes any workspace variable back out as a WAV.

%% cell 1
fs = 8000;

%% cell 2
t = (0:1/fs:1-1/fs)';

%% cell 3
f0 = 440;

%% cell 4
x = sin(2*pi*f0*t) + 0.3*randn(size(t));

%% cell 5
[pxx, f] = pwelch(x, [], [], [], fs);
plot(f, 10*log10(pxx));
title('power spectral density — before filtering');
xlabel('Hz'); ylabel('dB');

%% cell 6
cutoff = 600;   % edit me — everything below reacts

%% cell 7
b = fir1(40, cutoff / (fs/2));
y = filtfilt(b, 1, x);

%% cell 8
[pyy, fy] = pwelch(y, [], [], [], fs);
plot(fy, 10*log10(pyy));
title(sprintf('after lowpass filtering, cutoff = %d Hz', cutoff));
xlabel('Hz'); ylabel('dB');
