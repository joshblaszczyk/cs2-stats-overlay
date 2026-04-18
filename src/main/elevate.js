// Elevate the Electron process with UIAccess privileges
// This allows our overlay window to render above fullscreen windowed games
// by placing it in the ZBID_UIACCESS window band.
//
// Technique: Duplicate winlogon.exe's token, enable TokenUIAccess,
// then relaunch ourselves with that token.

const koffi = require('koffi');

const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');
const ntdll = koffi.load('ntdll.dll');

// Kernel32
const OpenProcess = kernel32.func('void* OpenProcess(uint32_t, int, uint32_t)');
const CloseHandle = kernel32.func('int CloseHandle(void*)');
const GetCurrentProcess = kernel32.func('void* GetCurrentProcess()');
const CreateToolhelp32Snapshot = kernel32.func('void* CreateToolhelp32Snapshot(uint32_t, uint32_t)');

// We need to define PROCESSENTRY32W struct
const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32_t',
  cntUsage: 'uint32_t',
  th32ProcessID: 'uint32_t',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32_t',
  cntThreads: 'uint32_t',
  th32ParentProcessID: 'uint32_t',
  pcPriClassBase: 'int32_t',
  dwFlags: 'uint32_t',
  szExeFile: koffi.array('char16_t', 260),
});

const Process32FirstW = kernel32.func('int Process32FirstW(void*, _Inout_ PROCESSENTRY32W*)');
const Process32NextW = kernel32.func('int Process32NextW(void*, _Inout_ PROCESSENTRY32W*)');

// Advapi32
const OpenProcessToken = advapi32.func('int OpenProcessToken(void*, uint32_t, _Out_ void**)');
const DuplicateTokenEx = advapi32.func('int DuplicateTokenEx(void*, uint32_t, void*, int, int, _Out_ void**)');
const SetTokenInformation = advapi32.func('int SetTokenInformation(void*, int, _In_ uint32_t*, uint32_t)');
const CreateProcessAsUserW = advapi32.func('int CreateProcessAsUserW(void*, str16, str16, void*, void*, int, uint32_t, void*, str16, _In_ void*, _Out_ void*)');

// Constants
const PROCESS_QUERY_INFORMATION = 0x0400;
const TOKEN_ALL_ACCESS = 0xF01FF;
const TOKEN_DUPLICATE = 0x0002;
const TOKEN_QUERY = 0x0008;
const SecurityIdentification = 2;
const TokenPrimary = 1;
const TokenUIAccess = 26;
const TH32CS_SNAPPROCESS = 0x00000002;
const CREATE_NEW_CONSOLE = 0x00000010;
const INVALID_HANDLE_VALUE = -1;

function findProcessByName(name) {
  const snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snapshot) return null;

  const entry = { dwSize: 568 }; // Size of PROCESSENTRY32W
  // Fill remaining fields
  entry.cntUsage = 0;
  entry.th32ProcessID = 0;
  entry.th32DefaultHeapID = 0;
  entry.th32ModuleID = 0;
  entry.cntThreads = 0;
  entry.th32ParentProcessID = 0;
  entry.pcPriClassBase = 0;
  entry.dwFlags = 0;
  entry.szExeFile = new Array(260).fill(0);

  let pid = null;

  if (Process32FirstW(snapshot, entry)) {
    do {
      const exeName = String.fromCharCode(...entry.szExeFile).replace(/\0+$/, '');
      if (exeName.toLowerCase() === name.toLowerCase()) {
        pid = entry.th32ProcessID;
        break;
      }
    } while (Process32NextW(snapshot, entry));
  }

  CloseHandle(snapshot);
  return pid;
}

function elevateWithUIAccess(electronExePath, appPath) {
  // Find winlogon.exe PID
  const winlogonPid = findProcessByName('winlogon.exe');
  if (!winlogonPid) {
    console.error('[Elevate] Could not find winlogon.exe');
    return false;
  }
  console.log('[Elevate] Found winlogon.exe PID:', winlogonPid);

  // Open winlogon process
  const hProcess = OpenProcess(PROCESS_QUERY_INFORMATION, 0, winlogonPid);
  if (!hProcess) {
    console.error('[Elevate] Could not open winlogon.exe process (need admin)');
    return false;
  }

  // Get its token
  const tokenOut = [null];
  if (!OpenProcessToken(hProcess, TOKEN_DUPLICATE | TOKEN_QUERY, tokenOut)) {
    console.error('[Elevate] Could not open process token');
    CloseHandle(hProcess);
    return false;
  }
  const hToken = tokenOut[0];

  // Duplicate token
  const newTokenOut = [null];
  if (!DuplicateTokenEx(hToken, TOKEN_ALL_ACCESS, null, SecurityIdentification, TokenPrimary, newTokenOut)) {
    console.error('[Elevate] Could not duplicate token');
    CloseHandle(hToken);
    CloseHandle(hProcess);
    return false;
  }
  const hNewToken = newTokenOut[0];

  // Enable UIAccess on the new token
  const uiAccessValue = Buffer.alloc(4);
  uiAccessValue.writeUInt32LE(1, 0);
  if (!SetTokenInformation(hNewToken, TokenUIAccess, uiAccessValue, 4)) {
    console.error('[Elevate] Could not set UIAccess on token');
    CloseHandle(hNewToken);
    CloseHandle(hToken);
    CloseHandle(hProcess);
    return false;
  }

  console.log('[Elevate] UIAccess token created, launching elevated process...');

  // Create startup info and process info buffers
  // STARTUPINFOW = 104 bytes on x64
  const startupInfo = Buffer.alloc(104);
  startupInfo.writeUInt32LE(104, 0); // cb = size

  const processInfo = Buffer.alloc(24); // PROCESS_INFORMATION

  const cmdLine = `"${electronExePath}" "${appPath}"`;
  const result = CreateProcessAsUserW(
    hNewToken,
    null,
    cmdLine,
    null,
    null,
    0,
    CREATE_NEW_CONSOLE,
    null,
    null,
    startupInfo,
    processInfo
  );

  CloseHandle(hNewToken);
  CloseHandle(hToken);
  CloseHandle(hProcess);

  if (!result) {
    console.error('[Elevate] CreateProcessAsUser failed');
    return false;
  }

  console.log('[Elevate] Elevated process launched successfully');
  return true;
}

module.exports = { elevateWithUIAccess };
