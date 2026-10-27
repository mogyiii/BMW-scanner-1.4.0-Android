@echo off
rem Builds FTD2XX.DLL, 32-bit, with no C runtime dependency.
rem
rem 32-bit because BMWScan140.exe is a 32-bit Delphi binary and will only load a 32-bit DLL.
rem No CRT because the DLL has to load on Windows XP, where the isolated VM lives, and because a
rem packed executable's start-up is no place to discover a runtime initialisation order problem.
rem /NODEFAULTLIB with an explicit entry point keeps the import list to kernel32 and user32.

setlocal
set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
if not exist "%VSWHERE%" (
    echo Could not find vswhere.exe - is Visual Studio installed?
    exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSPATH=%%i
if "%VSPATH%"=="" (
    echo Visual Studio found, but without the C++ build tools.
    echo Install "Desktop development with C++" and run this again.
    exit /b 1
)

call "%VSPATH%\VC\Auxiliary\Build\vcvarsall.bat" x86 >nul
if errorlevel 1 (
    echo Could not set up the 32-bit build environment.
    exit /b 1
)

cd /d "%~dp0"
cl /nologo /W3 /O2 /GS- /Gs1048576 /c ftd2xx_shim.c
if errorlevel 1 exit /b 1

link /nologo /DLL /MACHINE:X86 /NODEFAULTLIB /ENTRY:DllMain /SUBSYSTEM:WINDOWS,5.01 ^
     /DEF:ftd2xx.def /OUT:FTD2XX.DLL ftd2xx_shim.obj kernel32.lib user32.lib
if errorlevel 1 exit /b 1

echo.
echo Built FTD2XX.DLL. Copy it next to BMWScan140.exe, keeping the original somewhere safe.
echo Create an empty ftd2xx-rx.hex beside it; the log appears as ftd2xx-shim.log.
