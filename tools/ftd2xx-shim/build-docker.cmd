@echo off
rem Builds FTD2XX.DLL with a mingw-w64 cross-compiler in a container.
rem
rem This is the route that works on this machine: Visual Studio Community 2026 is installed but
rem without the C++ workload, so build.cmd has nothing to call. Docker Desktop needs to be running.
rem
rem The toolchain is baked into an image rather than installed per run, because searching for the
rem cable's sign-on means rebuilding repeatedly and a toolchain download each time would be absurd.

setlocal
cd /d "%~dp0"

docker image inspect bmwshim-build >nul 2>&1
if errorlevel 1 (
    echo Building the toolchain image, once...
    docker build -t bmwshim-build . || exit /b 1
)

docker run --rm -v "%cd%:/src" bmwshim-build bash -lc ^
  "rm -f FTD2XX.DLL && i686-w64-mingw32-gcc -O2 -shared -o FTD2XX.DLL ftd2xx_shim.c ftd2xx.def -Wl,--enable-stdcall-fixup -lkernel32 -luser32 2>&1 | grep -v 'stdcall-fixup\|resolving _FT_'; ls -l FTD2XX.DLL"
if errorlevel 1 exit /b 1

echo.
echo Copy FTD2XX.DLL and ftd2xx-rx.hex next to BMWScan140.exe, keeping the original DLL safe.
echo The log appears beside them as ftd2xx-shim.log.
