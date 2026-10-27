@echo off
rem ---------------------------------------------------------------------------
rem  Runs the whole announcement search inside the VM, unattended.
rem
rem  The shim serves one candidate per launch and keeps its place in
rem  ftd2xx-state.txt, so the search is simply "start the program, close it,
rem  start it again" - 267 times. Driving that from outside through the VM's
rem  keyboard costs a round trip per launch and is fragile besides; a batch file
rem  does it in one double-click.
rem
rem  First 11 launches retry the named guesses. The remaining 256 sweep the
rem  first byte through every value it can take, 64 copies queued each time, so
rem  that a correct first byte has somewhere to go. The shim prints how many
rem  bytes the software consumed at every close, and anything above one is the
rem  signal worth looking at.
rem
rem  tskill rather than taskkill, because tskill exists on every XP edition.
rem  ping as the sleep, because XP has no timeout command.
rem ---------------------------------------------------------------------------

setlocal
set EXE=C:\BMWScan140\BMWScan140.exe
set RUNS=267

if not exist "%EXE%" (
    echo Cannot find %EXE%
    pause
    exit /b 1
)

echo Running %RUNS% launches. This takes roughly 45 minutes.
echo Leave it alone; it closes each one by itself.
echo.

for /l %%i in (1,1,%RUNS%) do (
    echo [%%i/%RUNS%]
    start "" "%EXE%"
    ping -n 7 127.0.0.1 >nul
    tskill BMWScan140 >nul 2>&1
    ping -n 2 127.0.0.1 >nul
)

echo.
echo Done. Now look for the hits:
echo.
find /i "MORE THAN ONE" C:\BMWScan140\ftd2xx-shim.log
echo.
echo If nothing is listed above, no first byte changed the software's behaviour.
pause
