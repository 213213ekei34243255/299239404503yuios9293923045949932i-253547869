@echo off
rem Same as step4-build.cmd but -j 8 (14 ran out of memory once on 2026-11-17).
set PATH=C:\src\depot_tools;%PATH%
set DEPOT_TOOLS_WIN_TOOLCHAIN=0
cd /d C:\src\chromium\src
echo ==== %DATE% %TIME% build start
call autoninja -j 8 -C out\Jonah chrome
set RC=%ERRORLEVEL%
echo ==== %DATE% %TIME% build end, exit code %RC%
exit /b %RC%

