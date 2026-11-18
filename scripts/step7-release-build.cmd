@echo off
rem Jonah release-style build (out\JonahRelease). Runs at below-normal priority with 8 jobs so the PC stays responsive. Re-run to resume.
set PATH=C:\src\depot_tools;%PATH%
set DEPOT_TOOLS_WIN_TOOLCHAIN=0
cd /d C:\src\chromium\src
echo ==== %DATE% %TIME% release build start
call autoninja -j 8 -C out\JonahRelease chrome
set RC=%ERRORLEVEL%
echo ==== %DATE% %TIME% release build end, exit code %RC%
exit /b %RC%

