/*
 * A logging pass-through for FTD2XX.DLL.
 *
 * The shim in ../ftd2xx-shim answers the vendor software *instead of* a cable, which is how the
 * protocol was recovered with no hardware attached. This is the opposite tool and answers the
 * question that one cannot: **what does the genuine software say to the genuine cable, on the car?**
 *
 * It exports the same seventy-three names and forwards every one of them to the real driver,
 * logging the dozen that carry the conversation. The vendor software talks to its own hardware
 * through its own driver and never knows this is here; we get every byte in both directions.
 *
 * Installation is a rename and a copy:
 *
 *     C:\BMWScan140\FTD2XX.DLL      ->  C:\BMWScan140\ftd2xx_real.dll     (the genuine one)
 *     this DLL                      ->  C:\BMWScan140\FTD2XX.DLL
 *
 * Sixty-one of the exports are **forwarders declared in the .def file**, so the Windows loader
 * sends them straight to `ftd2xx_real.dll` without any code here. Only the ones worth logging are
 * implemented, which keeps the surface small enough to be obviously correct: there is no chance of
 * mangling a calling convention on a function nobody looks at.
 *
 * The log goes next to the executable, or to the shared folder when one is mounted.
 */

#include <windows.h>

#define FT_OK 0
typedef ULONG FT_STATUS;
typedef PVOID FT_HANDLE;

/* ------------------------------------------------------------------ logging */

static CRITICAL_SECTION g_lock;
static int g_lockReady = 0;
static CHAR g_logPath[MAX_PATH];
static HMODULE g_real = NULL;

static void openLog(void)
{
    CHAR dir[MAX_PATH];
    DWORD n = GetModuleFileNameA(NULL, dir, MAX_PATH);
    while (n > 0 && dir[n - 1] != '\\') n--;
    dir[n] = 0;

    if (GetFileAttributesA("\\\\vboxsvr\\xfer") != INVALID_FILE_ATTRIBUTES)
        wsprintfA(g_logPath, "\\\\vboxsvr\\xfer\\ftd2xx-proxy.log");
    else
        wsprintfA(g_logPath, "%sftd2xx-proxy.log", dir);
}

static void writeLine(const CHAR *s)
{
    HANDLE h;
    DWORD done;
    SYSTEMTIME t;
    CHAR stamp[32];

    h = CreateFileA(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, NULL, FILE_END);
    GetLocalTime(&t);
    wsprintfA(stamp, "%02d:%02d:%02d.%03d  ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    WriteFile(h, stamp, lstrlenA(stamp), &done, NULL);
    WriteFile(h, s, lstrlenA(s), &done, NULL);
    WriteFile(h, "\r\n", 2, &done, NULL);
    CloseHandle(h);
}

static void proxyLog(const CHAR *fmt, ...)
{
    CHAR buf[1024];
    va_list ap;
    va_start(ap, fmt);
    wvsprintfA(buf, fmt, ap);
    va_end(ap);
    if (g_lockReady) EnterCriticalSection(&g_lock);
    writeLine(buf);
    if (g_lockReady) LeaveCriticalSection(&g_lock);
}

/* Hex, in rows of sixteen, so a long transfer stays readable. */
static void logBytes(const CHAR *tag, const BYTE *data, DWORD n)
{
    CHAR line[160];
    DWORD i, k;
    for (i = 0; i < n; i += 16) {
        CHAR *p = line;
        k = 0;
        p += wsprintfA(p, "    %s[%u..] ", tag, i);
        for (; k < 16 && i + k < n; k++) p += wsprintfA(p, "%02X ", data[i + k]);
        writeLine(line);
    }
}

/* ------------------------------------------------------------------ the real driver */

typedef FT_STATUS (WINAPI *PF_Open)(int, FT_HANDLE *);
typedef FT_STATUS (WINAPI *PF_OpenEx)(PVOID, DWORD, FT_HANDLE *);
typedef FT_STATUS (WINAPI *PF_Close)(FT_HANDLE);
typedef FT_STATUS (WINAPI *PF_Read)(FT_HANDLE, LPVOID, DWORD, LPDWORD);
typedef FT_STATUS (WINAPI *PF_Write)(FT_HANDLE, LPVOID, DWORD, LPDWORD);
typedef FT_STATUS (WINAPI *PF_SetBaudRate)(FT_HANDLE, ULONG);
typedef FT_STATUS (WINAPI *PF_SetDataCharacteristics)(FT_HANDLE, UCHAR, UCHAR, UCHAR);
typedef FT_STATUS (WINAPI *PF_Purge)(FT_HANDLE, ULONG);
typedef FT_STATUS (WINAPI *PF_Dtr)(FT_HANDLE);
typedef FT_STATUS (WINAPI *PF_SetTimeouts)(FT_HANDLE, ULONG, ULONG);
typedef FT_STATUS (WINAPI *PF_GetQueueStatus)(FT_HANDLE, LPDWORD);
typedef FT_STATUS (WINAPI *PF_ListDevices)(PVOID, PVOID, DWORD);

static PF_Open                   r_Open;
static PF_OpenEx                 r_OpenEx;
static PF_Close                  r_Close;
static PF_Read                   r_Read;
static PF_Write                  r_Write;
static PF_SetBaudRate            r_SetBaudRate;
static PF_SetDataCharacteristics r_SetDataCharacteristics;
static PF_Purge                  r_Purge;
static PF_Dtr                    r_SetDtr;
static PF_Dtr                    r_ClrDtr;
static PF_SetTimeouts            r_SetTimeouts;
static PF_GetQueueStatus         r_GetQueueStatus;
static PF_ListDevices            r_ListDevices;

/*
 * Loads the genuine driver, which must sit beside this one as ftd2xx_real.dll.
 *
 * Deliberately not "FTD2XX.DLL from System32": on a machine where the vendor driver is installed
 * system-wide, that path could resolve back to this file and recurse. Requiring an explicitly
 * renamed copy in the same folder makes the arrangement impossible to get subtly wrong.
 */
static int loadReal(void)
{
    CHAR path[MAX_PATH];
    DWORD n;
    HMODULE self;

    if (g_real) return 1;

    self = GetModuleHandleA("FTD2XX.DLL");
    n = GetModuleFileNameA(self, path, MAX_PATH);
    while (n > 0 && path[n - 1] != '\\') n--;
    path[n] = 0;
    lstrcatA(path, "ftd2xx_real.dll");

    g_real = LoadLibraryA(path);
    if (!g_real) {
        proxyLog("CANNOT LOAD %s (error %u) - rename the genuine FTD2XX.DLL to ftd2xx_real.dll",
                 path, GetLastError());
        return 0;
    }
    proxyLog("real driver loaded from %s", path);

#define BIND(n) r_##n = (PF_##n)GetProcAddress(g_real, "FT_" #n)
    BIND(Open); BIND(OpenEx); BIND(Close); BIND(Read); BIND(Write);
    BIND(SetBaudRate); BIND(SetDataCharacteristics); BIND(Purge);
    BIND(SetTimeouts); BIND(GetQueueStatus); BIND(ListDevices);
#undef BIND
    r_SetDtr = (PF_Dtr)GetProcAddress(g_real, "FT_SetDtr");
    r_ClrDtr = (PF_Dtr)GetProcAddress(g_real, "FT_ClrDtr");
    return 1;
}

/* ------------------------------------------------------------------ intercepted calls */

FT_STATUS WINAPI FT_Open(int device, FT_HANDLE *handle)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_Open(device, handle);
    proxyLog("FT_Open(%d) -> %u", device, s);
    return s;
}

FT_STATUS WINAPI FT_OpenEx(PVOID arg1, DWORD flags, FT_HANDLE *handle)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_OpenEx(arg1, flags, handle);
    if (flags & 3) proxyLog("FT_OpenEx(flags=0x%X, \"%s\") -> %u", flags, (CHAR *)arg1, s);
    else proxyLog("FT_OpenEx(flags=0x%X) -> %u", flags, s);
    return s;
}

FT_STATUS WINAPI FT_Close(FT_HANDLE h)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_Close(h);
    proxyLog("FT_Close -> %u", s);
    return s;
}

FT_STATUS WINAPI FT_Write(FT_HANDLE h, LPVOID buffer, DWORD count, LPDWORD written)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_Write(h, buffer, count, written);
    proxyLog("FT_Write(%u) -> %u, wrote %u", count, s, written ? *written : 0);
    if (buffer && count) logBytes("TX", (const BYTE *)buffer, count);
    return s;
}

/*
 * Reads are logged only when they return something.
 *
 * The vendor software polls one byte at a time and spins on empty reads; logging those would bury
 * the traffic in thousands of blank lines, which is what made the shim's early logs so hard to use.
 */
FT_STATUS WINAPI FT_Read(FT_HANDLE h, LPVOID buffer, DWORD count, LPDWORD returned)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_Read(h, buffer, count, returned);
    if (returned && *returned) {
        proxyLog("FT_Read(asked %u) -> %u byte(s)", count, *returned);
        logBytes("RX", (const BYTE *)buffer, *returned);
    }
    return s;
}

FT_STATUS WINAPI FT_SetBaudRate(FT_HANDLE h, ULONG baud)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_SetBaudRate(h, baud);
    proxyLog("FT_SetBaudRate(%u) -> %u", baud, s);
    return s;
}

FT_STATUS WINAPI FT_SetDataCharacteristics(FT_HANDLE h, UCHAR bits, UCHAR stop, UCHAR parity)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_SetDataCharacteristics(h, bits, stop, parity);
    proxyLog("FT_SetDataCharacteristics(bits=%u stop=%u parity=%u) -> %u", bits, stop, parity, s);
    return s;
}

FT_STATUS WINAPI FT_Purge(FT_HANDLE h, ULONG mask)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_Purge(h, mask);
    proxyLog("FT_Purge(mask=%u) -> %u", mask, s);
    return s;
}

FT_STATUS WINAPI FT_SetDtr(FT_HANDLE h)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_SetDtr(h);
    proxyLog("FT_SetDtr   <-- DTR asserted");
    return s;
}

FT_STATUS WINAPI FT_ClrDtr(FT_HANDLE h)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_ClrDtr(h);
    proxyLog("FT_ClrDtr   <-- DTR released");
    return s;
}

FT_STATUS WINAPI FT_SetTimeouts(FT_HANDLE h, ULONG rd, ULONG wr)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_SetTimeouts(h, rd, wr);
    proxyLog("FT_SetTimeouts(read=%u write=%u) -> %u", rd, wr, s);
    return s;
}

FT_STATUS WINAPI FT_GetQueueStatus(FT_HANDLE h, LPDWORD count)
{
    if (!loadReal()) return 2;
    return r_GetQueueStatus(h, count);   /* polled constantly; not logged */
}

FT_STATUS WINAPI FT_ListDevices(PVOID a, PVOID b, DWORD flags)
{
    FT_STATUS s;
    if (!loadReal()) return 2;
    s = r_ListDevices(a, b, flags);
    proxyLog("FT_ListDevices(flags=0x%X) -> %u", flags, s);
    return s;
}

/* ------------------------------------------------------------------ entry */

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)inst; (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        InitializeCriticalSection(&g_lock);
        g_lockReady = 1;
        openLog();
        proxyLog("================ proxy loaded ================");
        proxyLog("pass-through to the genuine driver; every byte in both directions is logged");
    } else if (reason == DLL_PROCESS_DETACH) {
        proxyLog("================ proxy unloaded ==============");
    }
    return TRUE;
}
