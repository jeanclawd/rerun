% exported by ReRun — cells in dependency order, runs top-to-bottom

%% cell 1
a = 3;

%% cell 2
b = 4;

%% cell 3
t = linspace(0, 2*pi, 600);

%% cell 4
x = sin(a*t + pi/2);

%% cell 5
y = sin(b*t);

%% cell 6
plot(x, y);
title(sprintf('lissajous %d:%d', a, b));
axis equal;
