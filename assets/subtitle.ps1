# Persistent desktop subtitle overlay: one click-through, always-on-top, transparent WPF window.
#
# Node keeps this process alive and writes one JSON object per line on stdin:
#   {"op":"show","lines":[{"text":"sentence","at":0}],"size":34,"color":"#FFFFFF","vertical":"bottom","align":"center","hideAfter":0}
#   {"op":"hide"}
#   {"op":"quit"}
#
# "at" is the sentence start in milliseconds; hideAfter > 0 hides the overlay that many
# milliseconds after the show message (used for previews). EOF on stdin quits.
#
# Keep this file ASCII-only: Windows PowerShell reads BOM-less .ps1 files in the system code
# page, and the subtitle text itself arrives as UTF-8 JSON on stdin.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SubLayerNative {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
"@

$script:lines = @()
$script:index = -1
$script:clock = $null
$script:hideAfter = 0

$script:win = New-Object System.Windows.Window
$script:win.WindowStyle = [System.Windows.WindowStyle]::None
$script:win.AllowsTransparency = $true
$script:win.Background = [System.Windows.Media.Brushes]::Transparent
$script:win.Topmost = $true
$script:win.ShowInTaskbar = $false
$script:win.ShowActivated = $false
$script:win.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$script:win.ResizeMode = [System.Windows.ResizeMode]::NoResize
$script:win.IsHitTestVisible = $false

$script:text = New-Object System.Windows.Controls.TextBlock
$script:text.Text = ''
$script:text.TextWrapping = [System.Windows.TextWrapping]::Wrap
$script:text.TextAlignment = [System.Windows.TextAlignment]::Center
$script:text.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$script:text.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI')
$script:text.FontWeight = [System.Windows.FontWeights]::SemiBold
$shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
$shadow.BlurRadius = 10
$shadow.ShadowDepth = 0
$shadow.Opacity = 0.9
$shadow.Color = [System.Windows.Media.Color]::FromArgb(255, 0, 0, 0)
$script:text.Effect = $shadow

$script:win.Content = $script:text

function Set-Layout {
  param([double]$size, [string]$color, [string]$vertical, [string]$align)
  if ($size -lt 10) { $size = 10 }
  if ($size -gt 120) { $size = 120 }
  $script:text.FontSize = $size
  try {
    $script:text.Foreground = (New-Object System.Windows.Media.BrushConverter).ConvertFromString($color)
  } catch {
    $script:text.Foreground = [System.Windows.Media.Brushes]::White
  }
  if ($align -eq 'left') { $script:text.TextAlignment = [System.Windows.TextAlignment]::Left }
  elseif ($align -eq 'right') { $script:text.TextAlignment = [System.Windows.TextAlignment]::Right }
  else { $script:text.TextAlignment = [System.Windows.TextAlignment]::Center }

  $area = [System.Windows.SystemParameters]::WorkArea
  $height = [Math]::Max(90, $size * 5)
  $script:win.Width = $area.Width * 0.94
  $script:win.Height = $height
  $script:win.Left = $area.Left + ($area.Width - $script:win.Width) / 2
  $margin = [Math]::Max(28, $size * 1.2)
  if ($vertical -eq 'top') { $script:win.Top = $area.Top + $margin }
  elseif ($vertical -eq 'middle') { $script:win.Top = $area.Top + ($area.Height - $height) / 2 }
  else { $script:win.Top = $area.Top + $area.Height - $height - $margin }
}

function Apply-ClickThrough {
  $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:win)
  $ex = [SubLayerNative]::GetWindowLong($helper.Handle, -20)
  # WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
  [void][SubLayerNative]::SetWindowLong($helper.Handle, -20, $ex -bor 0x20 -bor 0x80000 -bor 0x08000000 -bor 0x80)
}

function Handle-Line {
  param([string]$raw)
  if ([string]::IsNullOrWhiteSpace($raw)) { return }
  $msg = $null
  try { $msg = $raw | ConvertFrom-Json } catch { return }
  if (-not $msg -or -not $msg.op) { return }

  if ($msg.op -eq 'quit') {
    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
    return
  }
  if ($msg.op -eq 'hide') {
    $script:lines = @()
    $script:index = -1
    $script:clock = $null
    $script:hideAfter = 0
    $script:text.Text = ''
    return
  }
  if ($msg.op -eq 'show') {
    $size = 34
    if ($null -ne $msg.size) { $size = [double]$msg.size }
    $color = '#FFFFFF'
    if ($msg.color) { $color = [string]$msg.color }
    $vertical = 'bottom'
    if ($msg.vertical) { $vertical = [string]$msg.vertical }
    $align = 'center'
    if ($msg.align) { $align = [string]$msg.align }
    Set-Layout -size $size -color $color -vertical $vertical -align $align

    $script:lines = @()
    foreach ($line in @($msg.lines)) {
      if ($null -eq $line) { continue }
      $script:lines += @{ text = [string]$line.text; at = [int]$line.at }
    }
    if ($script:lines.Count -eq 0) {
      $script:lines = @(@{ text = ''; at = 0 })
    }
    $script:hideAfter = 0
    if ($null -ne $msg.hideAfter) { $script:hideAfter = [int]$msg.hideAfter }
    $script:index = 0
    $script:text.Text = [string]$script:lines[0].text
    $script:clock = [System.Diagnostics.Stopwatch]::StartNew()
    $script:win.Topmost = $true
  }
}

$script:win.Show()
Apply-ClickThrough
Set-Layout -size 34 -color '#FFFFFF' -vertical 'bottom' -align 'center'

$script:reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$script:pending = $script:reader.ReadLineAsync()

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(50)
$timer.add_Tick({
  while ($script:pending -and $script:pending.IsCompleted) {
    $line = $script:pending.Result
    if ($null -eq $line) {
      $script:pending = $null
      [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
      return
    }
    Handle-Line -raw $line
    $script:pending = $script:reader.ReadLineAsync()
  }

  if ($null -eq $script:clock) { return }
  $elapsed = $script:clock.ElapsedMilliseconds
  if ($script:lines.Count -gt 1) {
    $next = 0
    for ($i = 0; $i -lt $script:lines.Count; $i++) {
      if ($elapsed -ge [int]$script:lines[$i].at) { $next = $i }
    }
    if ($next -ne $script:index) {
      $script:index = $next
      $script:text.Text = [string]$script:lines[$next].text
    }
  }
  if ($script:hideAfter -gt 0 -and $elapsed -gt $script:hideAfter) {
    $script:hideAfter = 0
    $script:lines = @()
    $script:index = -1
    $script:clock = $null
    $script:text.Text = ''
  }
})
$timer.Start()

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
[System.Windows.Threading.Dispatcher]::Run()
