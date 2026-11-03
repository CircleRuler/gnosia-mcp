param(
  [string]$CaptureDir = ""
)
# GNOSIA MCP host: long-running Windows capture/input worker.
# Protocol: one JSON request per line on stdin, one JSON response per line on stdout.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class GHost
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public int dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public int type; public INPUTUNION u; }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, IntPtr extra);

    public static void DpiAware() { try { SetProcessDPIAware(); } catch { } }

    public static Bitmap GrabClient(IntPtr h, out int cw, out int ch, out string method)
    {
        RECT wr; GetWindowRect(h, out wr);
        RECT cr; GetClientRect(h, out cr);
        POINT origin; origin.X = 0; origin.Y = 0; ClientToScreen(h, ref origin);
        cw = cr.Right - cr.Left; ch = cr.Bottom - cr.Top;
        int ox = origin.X - wr.Left; int oy = origin.Y - wr.Top;
        int ww = wr.Right - wr.Left; int wh = wr.Bottom - wr.Top;
        if (cw <= 0 || ch <= 0 || ww <= 0 || wh <= 0) throw new Exception("window has no drawable area (minimized?)");

        Bitmap full = new Bitmap(ww, wh, PixelFormat.Format32bppArgb);
        method = "printwindow";
        bool printed = false;
        try
        {
            using (Graphics g = Graphics.FromImage(full))
            {
                IntPtr hdc = g.GetHdc();
                printed = PrintWindow(h, hdc, 2);
                g.ReleaseHdc(hdc);
            }
        }
        catch { printed = false; }

        if (!printed || IsAllBlack(full)) method = "screen";
        if (method == "screen")
        {
            if (IsIconic(h)) throw new Exception("window is minimized and refused PrintWindow capture; call gnosia_focus first");
            full.Dispose();
            full = new Bitmap(Math.Max(ww, 1), Math.Max(wh, 1), PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(full))
            {
                g.CopyFromScreen(wr.Left, wr.Top, 0, 0, new Size(full.Width, full.Height), CopyPixelOperation.SourceCopy);
            }
        }

        Bitmap client = new Bitmap(cw, ch, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(client))
        {
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(full, new Rectangle(0, 0, cw, ch), new Rectangle(ox, oy, cw, ch), GraphicsUnit.Pixel);
        }
        full.Dispose();
        return client;
    }

    // A failed PrintWindow returns pure black everywhere. A genuinely dark game
    // screen still contains at least one non-zero pixel, so this test is safe.
    public static bool IsAllBlack(Bitmap bmp)
    {
        int stepX = Math.Max(1, bmp.Width / 40);
        int stepY = Math.Max(1, bmp.Height / 30);
        for (int y = 0; y < bmp.Height; y += stepY)
            for (int x = 0; x < bmp.Width; x += stepX)
            {
                Color c = bmp.GetPixel(x, y);
                if (c.R + c.G + c.B > 0) return false;
            }
        return true;
    }

    public static Bitmap CropNorm(Bitmap src, double rx, double ry, double rw, double rh)
    {
        int x = (int)Math.Round(rx * src.Width);
        int y = (int)Math.Round(ry * src.Height);
        int w = (int)Math.Round(rw * src.Width);
        int h = (int)Math.Round(rh * src.Height);
        if (x < 0) x = 0;
        if (y < 0) y = 0;
        if (x > src.Width - 8) x = src.Width - 8;
        if (y > src.Height - 8) y = src.Height - 8;
        if (x + w > src.Width) w = src.Width - x;
        if (y + h > src.Height) h = src.Height - y;
        if (w < 8) w = 8;
        if (h < 8) h = 8;
        Bitmap outBmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(outBmp))
        {
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(src, new Rectangle(0, 0, w, h), new Rectangle(x, y, w, h), GraphicsUnit.Pixel);
        }
        return outBmp;
    }

    public static Bitmap Resize(Bitmap src, double scale)
    {
        if (scale <= 0 || Math.Abs(scale - 1.0) < 0.01) return (Bitmap)src.Clone();
        int w = Math.Max(8, (int)Math.Round(src.Width * scale));
        int h = Math.Max(8, (int)Math.Round(src.Height * scale));
        Bitmap outBmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(outBmp))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.DrawImage(src, new Rectangle(0, 0, w, h));
        }
        return outBmp;
    }

    // Coarse perceptual signature: 32x18 mean-luma grid. Stable against
    // anti-aliasing noise, sensitive enough to tell "new text" from "same screen".
    public static string Signature(Bitmap bmp)
    {
        const int gw = 32, gh = 18;
        long[] cells = new long[gw * gh];
        long[] counts = new long[gw * gh];
        BitmapData d = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int stride = d.Stride;
            byte[] buffer = new byte[stride * bmp.Height];
            Marshal.Copy(d.Scan0, buffer, 0, buffer.Length);
            for (int y = 0; y < bmp.Height; y++)
            {
                int cy = (int)((long)y * gh / bmp.Height);
                int rowStart = y * stride;
                for (int x = 0; x < bmp.Width; x++)
                {
                    int i = rowStart + x * 4;
                    int cx = (int)((long)x * gw / bmp.Width);
                    int cell = cy * gw + cx;
                    cells[cell] += (buffer[i + 2] * 299 + buffer[i + 1] * 587 + buffer[i] * 114) / 1000;
                    counts[cell]++;
                }
            }
        }
        finally { bmp.UnlockBits(d); }

        System.Text.StringBuilder sb = new System.Text.StringBuilder(gw * gh * 2);
        long total = 0;
        for (int i = 0; i < cells.Length; i++)
        {
            long v = counts[i] > 0 ? cells[i] / counts[i] : 0;
            total += v;
            if (v > 255) v = 255;
            sb.Append(((int)v).ToString("x2"));
        }
        return sb.ToString() + "|" + Math.Round(total / (double)cells.Length, 1).ToString("0.0");
    }

    public static double Luma(Bitmap bmp)
    {
        long sum = 0; int n = 0;
        int stepX = Math.Max(1, bmp.Width / 48);
        int stepY = Math.Max(1, bmp.Height / 36);
        for (int y = 0; y < bmp.Height; y += stepY)
            for (int x = 0; x < bmp.Width; x += stepX)
            { Color c = bmp.GetPixel(x, y); sum += (c.R * 299 + c.G * 587 + c.B * 114) / 1000; n++; }
        return n == 0 ? 0 : Math.Round(sum / (double)n, 1);
    }

    public static Bitmap Montage(Bitmap[] frames, int cols)
    {
        int n = frames.Length;
        if (n == 0) throw new Exception("no frames");
        if (cols < 1) cols = 1;
        if (cols > n) cols = n;
        int rows = (int)Math.Ceiling(n / (double)cols);
        int cw = frames[0].Width, ch = frames[0].Height;
        int labelH = Math.Max(24, ch / 12);
        Bitmap outBmp = new Bitmap(cols * cw, rows * (ch + labelH), PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(outBmp))
        {
            g.Clear(Color.FromArgb(255, 16, 16, 16));
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            using (Font f = new Font("Consolas", labelH * 0.62f, FontStyle.Bold))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(255, 255, 210, 60)))
            {
                for (int i = 0; i < n; i++)
                {
                    int col = i % cols; int row = i / cols;
                    int x = col * cw; int y = row * (ch + labelH);
                    g.DrawImage(frames[i], new Rectangle(x, y, cw, ch));
                    g.DrawString("#" + (i + 1), f, b, x + 8, y + ch + 2);
                }
            }
        }
        return outBmp;
    }

    public static void Click(int x, int y, bool right, bool doubleClick)
    {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(40);
        uint down = right ? 0x0008u : 0x0002u;
        uint up = right ? 0x0010u : 0x0004u;
        for (int i = 0; i < (doubleClick ? 2 : 1); i++)
        {
            mouse_event(down, 0, 0, 0, IntPtr.Zero);
            System.Threading.Thread.Sleep(35);
            mouse_event(up, 0, 0, 0, IntPtr.Zero);
            if (doubleClick) System.Threading.Thread.Sleep(60);
        }
    }

    public static void Wheel(int x, int y, int delta)
    {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(30);
        mouse_event(0x0800u, 0, 0, delta, IntPtr.Zero);
    }

    public static void KeyTap(ushort vk, int holdMs)
    {
        INPUT[] down = new INPUT[1];
        down[0].type = 1;
        down[0].u.ki.wVk = vk;
        down[0].u.ki.dwFlags = 0;
        SendInput(1, down, Marshal.SizeOf(typeof(INPUT)));
        System.Threading.Thread.Sleep(Math.Max(10, holdMs));
        INPUT[] up = new INPUT[1];
        up[0].type = 1;
        up[0].u.ki.wVk = vk;
        up[0].u.ki.dwFlags = 2;
        SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void PostClose(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@

[GHost]::DpiAware()
$script:Target = $null
$script:LastHash = ""

function Get-Target {
  if ($null -ne $script:Target) {
    $alive = $null
    try { $alive = Get-Process -Id $script:Target.Id -ErrorAction Stop } catch { $alive = $null }
    if ($null -ne $alive -and $alive.MainWindowHandle -ne [IntPtr]::Zero) { return $alive }
    $script:Target = $null
  }
  $cand = @(Get-Process -Name 'Gnosia' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
  if ($cand.Count -eq 0) { return $null }
  $picked = $cand | Sort-Object StartTime -Descending | Select-Object -First 1
  $script:Target = $picked
  return $picked
}

function Require-Target {
  $p = Get-Target
  if ($null -eq $p) { throw "GNOSIA window not found (process 'Gnosia' is not running or has no window). Call gnosia_launch first." }
  return $p
}

function Get-Geo {
  $p = Require-Target
  $h = $p.MainWindowHandle
  $wr = New-Object GHost+RECT; [void][GHost]::GetWindowRect($h, [ref]$wr)
  $cr = New-Object GHost+RECT; [void][GHost]::GetClientRect($h, [ref]$cr)
  $origin = New-Object GHost+POINT; [void][GHost]::ClientToScreen($h, [ref]$origin)
  [pscustomobject]@{
    hwnd = [int64]$h
    pid = $p.Id
    title = $p.MainWindowTitle
    client_width = ($cr.Right - $cr.Left)
    client_height = ($cr.Bottom - $cr.Top)
    client_x = $origin.X
    client_y = $origin.Y
    window_left = $wr.Left
    window_top = $wr.Top
    window_width = ($wr.Right - $wr.Left)
    window_height = ($wr.Bottom - $wr.Top)
    minimized = [bool][GHost]::IsIconic($h)
    foreground = ([GHost]::GetForegroundWindow() -eq $h)
  }
}

function Take-Shot {
  param($Region, [double]$Scale = 1.0)
  $geo = Get-Geo
  $h = [IntPtr]$geo.hwnd
  $cw = 0; $ch = 0; $method = "printwindow"
  $bmp = [GHost]::GrabClient($h, [ref]$cw, [ref]$ch, [ref]$method)
  $work = $bmp
  try {
    if ($null -ne $Region) {
      $work = [GHost]::CropNorm($bmp, [double]$Region.x, [double]$Region.y, [double]$Region.w, [double]$Region.h)
      $bmp.Dispose()
      $bmp = $work
    }
    if ($Scale -ne 1.0) {
      $scaled = [GHost]::Resize($work, $Scale)
      $work.Dispose()
      $work = $scaled
      $bmp = $work
    }
    $sig = [GHost]::Signature($work)
    $luma = [GHost]::Luma($work)
    return [pscustomobject]@{ bitmap = $work; signature = $sig; luma = $luma; method = $method; geo = $geo; width = $work.Width; height = $work.Height }
  } catch {
    $work.Dispose()
    throw
  }
}

function Save-Shot {
  param($Bitmap, [string]$Path)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  return $Path
}

# Mean absolute difference between two 32x18 luma grids. A blinking cursor or a
# breathing portrait moves a couple of cells by a few points; typing a new line
# of text moves many cells a lot. Comparing with a threshold instead of exact
# equality is what keeps "wait until the text stops changing" fast.
function Compare-Sig {
  param([string]$a, [string]$b)
  if (-not $a -or -not $b) { return 255.0 }
  $ga = $a.Split('|')[0]
  $gb = $b.Split('|')[0]
  if ($ga.Length -ne $gb.Length -or $ga.Length -eq 0) { return 255.0 }
  $sum = 0
  for ($i = 0; $i -lt $ga.Length; $i += 2) {
    $x = [Convert]::ToInt32($ga.Substring($i, 2), 16)
    $y = [Convert]::ToInt32($gb.Substring($i, 2), 16)
    $sum += [math]::Abs($x - $y)
  }
  return [math]::Round($sum / ($ga.Length / 2), 2)
}

function Invoke-Cmd {
  param($req)
  $cmd = [string]$req.cmd
  $a = $req.args
  switch ($cmd) {
    'ping' {
      return @{ pong = $true; host_pid = $PID; capture_dir = $CaptureDir; ps_version = $PSVersionTable.PSVersion.ToString() }
    }
    'info' {
      $p = Get-Target
      if ($null -eq $p) { return @{ running = $false } }
      $geo = Get-Geo
      $out = @{ running = $true }
      foreach ($k in $geo.PSObject.Properties.Name) { $out[$k] = $geo.$k }
      return $out
    }
    'capture' {
      $region = $null
      if ($null -ne $a.region) { $region = $a.region }
      $scale = 1.0
      if ($null -ne $a.scale) { $scale = [double]$a.scale }
      $shot = Take-Shot -Region $region -Scale $scale
      try {
        $path = ""
        if ($a.save -and $a.path) { $path = Save-Shot -Bitmap $shot.bitmap -Path ([string]$a.path) }
        $parts = $shot.signature.Split('|')
        $diff = if ($script:LastHash) { Compare-Sig $script:LastHash $shot.signature } else { 255.0 }
        $changed = ($script:LastHash -ne "" -and $diff -ge 2.0)
        $script:LastHash = $shot.signature
        return @{
          path = $path
          width = $shot.width
          height = $shot.height
          hash = $parts[0]
          mean_luma = [double]$parts[1]
          diff_since_last_capture = $diff
          changed_since_last_capture = $changed
          capture_method = $shot.method
          client_width = $shot.geo.client_width
          client_height = $shot.geo.client_height
          minimized = $shot.geo.minimized
          foreground = $shot.geo.foreground
        }
      } finally { $shot.bitmap.Dispose() }
    }
    'signature' {
      $region = $null
      if ($null -ne $a.region) { $region = $a.region }
      $shot = Take-Shot -Region $region -Scale 1.0
      try {
        $parts = $shot.signature.Split('|')
        $diff = if ($script:LastHash) { Compare-Sig $script:LastHash $shot.signature } else { 255.0 }
        $changed = ($script:LastHash -ne "" -and $diff -ge 2.0)
        $script:LastHash = $shot.signature
        return @{ hash = $shot.signature; grid = $parts[0]; mean_luma = [double]$parts[1]; diff_since_last_capture = $diff; changed_since_last_capture = $changed; minimized = $shot.geo.minimized }
      } finally { $shot.bitmap.Dispose() }
    }
    'click' {
      $geo = Get-Geo
      $nx = [double]$a.x; $ny = [double]$a.y
      if ($nx -lt 0 -or $nx -gt 1 -or $ny -lt 0 -or $ny -gt 1) { throw "normalized coordinates must be within 0..1 (got $nx, $ny)" }
      $sx = [int][math]::Round($geo.client_x + $nx * $geo.client_width) - 1
      $sy = [int][math]::Round($geo.client_y + $ny * $geo.client_height) - 1
      [void][GHost]::SetForegroundWindow([IntPtr]$geo.hwnd)
      Start-Sleep -Milliseconds 60
      [GHost]::Click($sx, $sy, [bool]$a.right, [bool]$a.double)
      $wait = 400
      if ($null -ne $a.settle_ms) { $wait = [int]$a.settle_ms }
      Start-Sleep -Milliseconds $wait
      return @{ clicked = $true; normalized = @{ x = $nx; y = $ny }; screen = @{ x = $sx; y = $sy }; foreground = ([GHost]::GetForegroundWindow() -eq [IntPtr]$geo.hwnd) }
    }
    'wheel' {
      $geo = Get-Geo
      $nx = [double]$a.x; $ny = [double]$a.y
      $sx = [int][math]::Round($geo.client_x + $nx * $geo.client_width) - 1
      $sy = [int][math]::Round($geo.client_y + $ny * $geo.client_height) - 1
      [void][GHost]::SetForegroundWindow([IntPtr]$geo.hwnd)
      Start-Sleep -Milliseconds 60
      [GHost]::Wheel($sx, $sy, [int]$a.delta)
      Start-Sleep -Milliseconds 200
      return @{ scrolled = $true; delta = [int]$a.delta }
    }
    'key' {
      $p = Require-Target
      $h = [IntPtr]$p.MainWindowHandle
      [void][GHost]::ShowWindow($h, 9)
      [void][GHost]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 80
      $vks = @($a.vks)
      $hold = 40
      if ($null -ne $a.hold_ms) { $hold = [int]$a.hold_ms }
      $gap = 45
      if ($null -ne $a.gap_ms) { $gap = [int]$a.gap_ms }
      foreach ($vk in $vks) {
        [GHost]::KeyTap([uint16]$vk, $hold)
        Start-Sleep -Milliseconds $gap
      }
      $wait = 250
      if ($null -ne $a.settle_ms) { $wait = [int]$a.settle_ms }
      Start-Sleep -Milliseconds $wait
      return @{ sent = @($a.names); vks = $vks; foreground = ([GHost]::GetForegroundWindow() -eq $h) }
    }
    'focus' {
      $p = Require-Target
      $h = [IntPtr]$p.MainWindowHandle
      [void][GHost]::ShowWindow($h, 9)
      [void][GHost]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 200
      $geo = Get-Geo
      return @{ focused = ([GHost]::GetForegroundWindow() -eq $h); geo = $geo }
    }
    'close' {
      $p = Require-Target
      [GHost]::PostClose([IntPtr]$p.MainWindowHandle)
      return @{ requested = $true; pid = $p.Id }
    }
    'wait_stable' {
      $region = $null
      if ($null -ne $a.region) { $region = $a.region }
      $timeout = 6000
      if ($null -ne $a.timeout_ms) { $timeout = [int]$a.timeout_ms }
      $quiet = 350
      if ($null -ne $a.quiet_ms) { $quiet = [int]$a.quiet_ms }
      $interval = 120
      if ($null -ne $a.interval_ms) { $interval = [int]$a.interval_ms }
      $tol = 2.0
      if ($null -ne $a.tolerance) { $tol = [double]$a.tolerance }
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $last = $null; $lastChange = 0; $samples = 0; $lastDiff = 0.0
      while ($sw.ElapsedMilliseconds -lt $timeout) {
        $shot = Take-Shot -Region $region -Scale 1.0
        try { $sig = $shot.signature } finally { $shot.bitmap.Dispose() }
        $samples++
        $diff = if ($last) { Compare-Sig $last $sig } else { 255.0 }
        $lastDiff = $diff
        if ($diff -ge $tol) { $last = $sig; $lastChange = $sw.ElapsedMilliseconds }
        elseif (($sw.ElapsedMilliseconds - $lastChange) -ge $quiet) {
          return @{ stable = $true; waited_ms = $sw.ElapsedMilliseconds; quiet_ms = $quiet; samples = $samples; hash = $sig; last_diff = $lastDiff }
        }
        Start-Sleep -Milliseconds $interval
      }
      return @{ stable = $false; waited_ms = $sw.ElapsedMilliseconds; quiet_ms = $quiet; samples = $samples; hash = $last; last_diff = $lastDiff; timed_out = $true }
    }
    'wait_change' {
      $region = $null
      if ($null -ne $a.region) { $region = $a.region }
      $timeout = 6000
      if ($null -ne $a.timeout_ms) { $timeout = [int]$a.timeout_ms }
      $interval = 120
      if ($null -ne $a.interval_ms) { $interval = [int]$a.interval_ms }
      $baseline = [string]$a.baseline
      $tol = 2.0
      if ($null -ne $a.tolerance) { $tol = [double]$a.tolerance }
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      while ($sw.ElapsedMilliseconds -lt $timeout) {
        $shot = Take-Shot -Region $region -Scale 1.0
        try { $sig = $shot.signature } finally { $shot.bitmap.Dispose() }
        $diff = Compare-Sig $baseline $sig
        if ($diff -ge $tol) { return @{ changed = $true; waited_ms = $sw.ElapsedMilliseconds; hash = $sig; diff = $diff } }
        Start-Sleep -Milliseconds $interval
      }
      return @{ changed = $false; waited_ms = $sw.ElapsedMilliseconds; hash = $baseline; timed_out = $true }
    }
    'frames' {
      $region = $null
      if ($null -ne $a.region) { $region = $a.region }
      $count = 4
      if ($null -ne $a.count) { $count = [int]$a.count }
      $interval = 400
      if ($null -ne $a.interval_ms) { $interval = [int]$a.interval_ms }
      $scale = 0.5
      if ($null -ne $a.scale) { $scale = [double]$a.scale }
      $cols = 2
      if ($null -ne $a.cols) { $cols = [int]$a.cols }
      $list = New-Object System.Collections.ArrayList
      $hashes = New-Object System.Collections.ArrayList
      for ($i = 0; $i -lt $count; $i++) {
        $shot = Take-Shot -Region $region -Scale $scale
        [void]$list.Add($shot.bitmap)
        [void]$hashes.Add($shot.signature.Split('|')[0])
        if ($i -lt $count - 1) { Start-Sleep -Milliseconds $interval }
      }
      $arr = New-Object 'System.Drawing.Bitmap[]' $count
      for ($i = 0; $i -lt $count; $i++) { $arr[$i] = $list[$i] }
      $sheet = [GHost]::Montage($arr, $cols)
      foreach ($b in $list) { $b.Dispose() }
      try {
        $path = ""
        if ($a.save -and $a.path) { $path = Save-Shot -Bitmap $sheet -Path ([string]$a.path) }
        return @{ path = $path; width = $sheet.Width; height = $sheet.Height; count = $count; frames_changed = (@($hashes | Select-Object -Unique).Count -gt 1); hashes = @($hashes) }
      } finally { $sheet.Dispose() }
    }
    'kill' {
      $p = Require-Target
      $killedPid = $p.Id
      $p.Kill()
      return @{ killed = $true; pid = $killedPid }
    }
    'quit_host' { return @{ bye = $true } }
    default { throw "unknown command: $cmd" }
  }
}

$req = $null
$stdin = [Console]::In
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $req = $null
  $rid = $null
  try {
    $req = $line | ConvertFrom-Json
    $rid = $req.id
    $res = Invoke-Cmd -req $req
    $obj = @{ id = $rid; ok = $true; result = $res }
    $quit = ([string]$req.cmd -eq 'quit_host')
  } catch {
    $obj = @{ id = $rid; ok = $false; error = $_.Exception.Message }
    $quit = $false
  }
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.Write($json + "`n")
  [Console]::Out.Flush()
  if ($quit) { break }
}
