%[text] # Damped Oscillator
%[text] A plain-text **live-script** `.m` document, imported by ReRun as a
%[text] reactive notebook. Prose becomes text cells; code becomes DAG-analyzed
%[text] code cells. See the [format spec](https://www.mathworks.com/help/matlab/matlab_prog/plain-text-file-format-for-live-scripts.html).
%[text]
%[text] ## Parameters
%[text] The frequency and damping below are driven by controls in the source
%[text] live script. For this import they splice to their default values.
f = 3; %[control:slider:freq01]{"position":[5,5]}

tau = 4; %[control:slider:damp01]{"position":[7,7]}
%[text]
%[text] ## Signal
%[text] A damped sine over one span of `t`:
t = linspace(0, 2*pi, 400);
y = sin(f*t) .* exp(-t/tau);
%[output:ignored99]
%[text] ## Plot
%[text] Moving a control (Phase 2) would rerun only the cells downstream of it.
plot(t, y);
title(sprintf('damped sine, f = %d', f));
xlabel('t'); ylabel('y');
%[text]
%[text] ## Summary
%[text] The peak amplitude and a small results table:
%[text:table]
%[text] | quantity | value |
%[text] | --- | --- |
%[text] | samples | 400 |
%[text] | frequency | f |
%[text:table]
peak = max(y)

%[appendix]{"version":"1.0"}
%---
%[metadata:view]
%   data: {"layout":"inline","rightPanelPercent":20}
%---
%[control:slider:freq01]
%   data: {"defaultValue":4,"label":"frequency","max":10,"min":1,"step":1}
%---
%[control:slider:damp01]
%   data: {"defaultValue":6,"label":"damping","max":10,"min":1,"step":1}
%---
%[output:ignored99]
%   data: {"dataType":"text","outputData":{"text":"stale saved output — ReRun ignores this","truncated":false}}
%---
