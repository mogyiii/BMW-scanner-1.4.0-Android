/*
 * Runs the Android app's exact sequence on Windows, through the genuine FTDI driver.
 *
 * By run 60 everything about the bytes had been ruled out. The frames are byte-identical to the
 * vendor's at the same scrambling key, the pacing makes no difference across 0, 3 and 15 ms per
 * byte, a verbatim replay of the vendor's own recorded stream fails exactly like ours, the
 * handshake lines change nothing, and the ignition was confirmed on by the line-idle check. Yet the
 * vendor software reads this car and we do not.
 *
 * What has never been separated is the layer underneath: our Android code drives the FT232R with
 * raw USB control requests of its own, while the vendor talks to a driver. This program sends the
 * same sequence the app sends, but through that driver, and so splits the question in two:
 *
 *   it works here   -> the sequence is right and our raw-USB FTDI layer is wrong
 *   it fails here   -> the sequence is wrong, and the vendor does something we have not captured
 *
 * Either answer is worth more than another run at the car, and this needs no car at all to build.
 *
 * Put it next to BMWScan140.exe and run it from a command prompt. If the logging proxy is installed
 * the traffic lands in ftd2xx-proxy.log as well, which is free corroboration.
 */

#include <windows.h>
#include <stdio.h>

typedef ULONG FT_STATUS;
typedef PVOID FT_HANDLE;
#define FT_OK 0

typedef FT_STATUS (WINAPI *PF_OpenEx)(PVOID, DWORD, FT_HANDLE *);
typedef FT_STATUS (WINAPI *PF_Close)(FT_HANDLE);
typedef FT_STATUS (WINAPI *PF_Read)(FT_HANDLE, LPVOID, DWORD, LPDWORD);
typedef FT_STATUS (WINAPI *PF_Write)(FT_HANDLE, LPVOID, DWORD, LPDWORD);
typedef FT_STATUS (WINAPI *PF_SetBaudRate)(FT_HANDLE, ULONG);
typedef FT_STATUS (WINAPI *PF_SetData)(FT_HANDLE, UCHAR, UCHAR, UCHAR);
typedef FT_STATUS (WINAPI *PF_Purge)(FT_HANDLE, ULONG);
typedef FT_STATUS (WINAPI *PF_Dtr)(FT_HANDLE);
typedef FT_STATUS (WINAPI *PF_SetTimeouts)(FT_HANDLE, ULONG, ULONG);

static PF_OpenEx       f_OpenEx;
static PF_Close        f_Close;
static PF_Read         f_Read;
static PF_Write        f_Write;
static PF_SetBaudRate  f_SetBaudRate;
static PF_SetData      f_SetData;
static PF_Purge        f_Purge;
static PF_Dtr          f_SetDtr, f_ClrDtr;
static PF_SetTimeouts  f_SetTimeouts;

static FT_HANDLE h;
static BYTE key;

static void dump(const char *tag, const BYTE *b, DWORD n)
{
    DWORD i;
    printf("    %s (%u):", tag, n);
    for (i = 0; i < n; i++) printf(" %02X", b[i]);
    printf("\n");
}

/* The app's scrambler: XOR with a key that advances 0x4B per byte and is never reset. */
static void sendFrame(const BYTE *plain, DWORD n, const char *label)
{
    BYTE wire[64];
    DWORD i, written = 0;
    for (i = 0; i < n; i++) { wire[i] = (BYTE)(plain[i] ^ key); key = (BYTE)(key + 0x4B); }
    printf("  -> %s\n", label);
    dump("tx", wire, n);
    f_Write(h, wire, n, &written);
}

/* Reads for about `ms` milliseconds, collecting whatever turns up. */
static DWORD readFor(BYTE *out, DWORD cap, DWORD ms)
{
    DWORD total = 0, got;
    DWORD end = GetTickCount() + ms;
    while (GetTickCount() < end && total < cap) {
        got = 0;
        if (f_Read(h, out + total, 1, &got) != FT_OK) break;
        if (got) { total += got; end = GetTickCount() + 120; }  /* extend while it keeps talking */
        else Sleep(5);
    }
    return total;
}

static void step(const BYTE *plain, DWORD n, const char *label, DWORD window)
{
    BYTE buf[256];
    DWORD got;
    f_Purge(h, 3);
    sendFrame(plain, n, label);
    got = readFor(buf, sizeof(buf), window);
    if (got) dump("rx", buf, got); else printf("    rx: nothing\n");
}

int main(void)
{
    HMODULE lib;
    BYTE ann[32];
    DWORD got, i;
    FT_STATUS s;

    /* The genuine driver, renamed if the logging proxy is installed; otherwise the plain name. */
    lib = LoadLibraryA("ftd2xx_real.dll");
    if (!lib) lib = LoadLibraryA("FTD2XX.DLL");
    if (!lib) { printf("no FTDI library here. Run this next to BMWScan140.exe.\n"); return 1; }

#define BIND(n) f_##n = (PF_##n)GetProcAddress(lib, "FT_" #n)
    BIND(OpenEx); BIND(Close); BIND(Read); BIND(Write);
    BIND(SetBaudRate); BIND(Purge); BIND(SetTimeouts);
#undef BIND
    f_SetData = (PF_SetData)GetProcAddress(lib, "FT_SetDataCharacteristics");
    f_SetDtr  = (PF_Dtr)GetProcAddress(lib, "FT_SetDtr");
    f_ClrDtr  = (PF_Dtr)GetProcAddress(lib, "FT_ClrDtr");
    if (!f_OpenEx || !f_Write || !f_SetData) { printf("library is missing exports\n"); return 1; }

    s = f_OpenEx("BMW Scanner V14x", 2, &h);
    if (s != FT_OK) { printf("FT_OpenEx failed (%lu). Is the cable plugged in?\n", s); return 1; }
    printf("opened\n");

    f_SetBaudRate(h, 19200);
    f_SetData(h, 8, 0, 0);
    f_SetTimeouts(h, 800, 800);
    f_Purge(h, 3);

    f_SetDtr(h);
    Sleep(150);
    f_ClrDtr(h);

    got = readFor(ann, sizeof(ann), 1200);
    dump("announcement", ann, got);
    if (got < 27) { printf("expected 27 bytes; stopping\n"); f_Close(h); return 1; }
    {
        BYTE x = 0;
        for (i = 0; i < 27; i++) x ^= ann[i];
        printf("    XOR of 27 = %02X (should be 00)\n", x);
    }
    key = ann[0];
    printf("    key = %02X\n", key);

    {
        /* The same four frames the Android app builds, in the same order. */
        static const BYTE signOn[36] = {
            0x22,0xA7,0x7A,0x56,0x31,0x34,0x34,0x42,0x6E,0x39,0x9D,0x3E,0xAF,0x2E,0xA9,0x45,
            0x78,0x80,0xB7,0xAA,0xF6,0xA9,0xFC,0x9F,0xEE,0xD2,0x7C,0x59,0x90,0x79,0x80,0x59,
            0x84,0x88,0x03,0xDA };
        static const BYTE open80[6]  = { 0x04,0xB3,0x18,0x80,0x01,0x50 };
        static const BYTE bus80[11]  = { 0x09,0x83,0xF0,0x80,0xE5,0x50,0x47,0x66,0x28,0x14,0x1A };
        static const BYTE query80[5] = { 0x03,0x46,0xF1,0x80,0xBA };

        step(signOn, sizeof(signOn), "0xA77A sign-on",      1200);
        step(open80, sizeof(open80), "0xB318 open",          700);
        step(bus80,  sizeof(bus80),  "0x83F0 timing",        800);

        printf("  -- line to 9600 8E1\n");
        f_SetBaudRate(h, 9600);
        f_SetData(h, 8, 0, 2);

        step(query80, sizeof(query80), "0x46F1 query",      1000);
    }

    printf("\nIf the query line shows 80 04 00 84 80 12 A0 ... then the sequence is right\n"
           "and the Android side's raw-USB FTDI layer is what differs.\n");
    f_Close(h);
    return 0;
}
