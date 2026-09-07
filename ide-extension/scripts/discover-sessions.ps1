$ErrorActionPreference = 'Stop'
# Read-only Restart Manager queries. Never call shutdown/restart APIs.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SwitcherLockOwners {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess {
    public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME start;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string app;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
    public uint type; public uint status; public uint session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint files, string[] paths, uint processes, IntPtr apps, uint services, string[] names);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  public static uint[] Read(string path) {
    uint handle; if (RmStartSession(out handle,0,Guid.NewGuid().ToString("N")) != 0) return new uint[0];
    try {
      if (RmRegisterResources(handle,1,new[]{path},0,IntPtr.Zero,0,null)!=0) return new uint[0];
      uint needed=0,count=0,reasons=0;
      int result=RmGetList(handle,out needed,ref count,null,ref reasons);
      if(result==0) return new uint[0];
      if(result!=234 || needed>256) return new uint[0];
      var info=new ProcessInfo[needed]; count=needed;
      if(RmGetList(handle,out needed,ref count,info,ref reasons)!=0) return new uint[0];
      var ids=new uint[count]; for(int i=0;i<count;i++) ids[i]=info[i].process.pid;
      return ids;
    } finally { RmEndSession(handle); }
  }
}
'@
$codexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$locksDirectory = Join-Path $codexDirectory 'thread-writer-locks'
$processes = @{}
Get-CimInstance Win32_Process | ForEach-Object { $processes[[uint32]$_.ProcessId] = $_ }
$results = @()
if (Test-Path -LiteralPath $locksDirectory) {
  foreach ($file in Get-ChildItem -LiteralPath $locksDirectory -Filter '*.lock' -File | Select-Object -First 512) {
    if ($file.BaseName -notmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { continue }
    foreach ($owner in [SwitcherLockOwners]::Read($file.FullName)) {
      $proc = $processes[[uint32]$owner]
      if (!$proc -or $proc.Name -ne 'codex.exe') { continue }
      $ancestors = @(); $cursor = $proc; $seen = @{}
      for ($depth=0; $depth -lt 32 -and $cursor; $depth++) {
        $parentId = [uint32]$cursor.ParentProcessId
        if ($seen.ContainsKey($parentId)) { break }
        $seen[$parentId] = $true
        $parent = $processes[$parentId]
        if (!$parent -or $parent.CreationDate -gt $cursor.CreationDate) { break }
        $ancestors += [int]$parentId
        $cursor = $parent
      }
      $results += @{sessionId=$file.BaseName.ToLowerInvariant();processId=[int]$owner;ancestors=$ancestors}
    }
  }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 4
