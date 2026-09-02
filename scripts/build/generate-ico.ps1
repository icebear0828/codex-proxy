Add-Type -AssemblyName System.Drawing

function Convert-PngToIco {
    param(
        [string]$InputPng,
        [string]$OutputIco,
        [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
    )
    $src = [System.Drawing.Image]::FromFile($InputPng)
    $images = @()
    foreach ($size in $Sizes) {
        $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.DrawImage($src, 0, 0, $size, $size)
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $images += ,@($size, $ms.ToArray())
        $ms.Dispose()
    }
    $src.Dispose()

    $fs = [System.IO.File]::Create($OutputIco)
    $bw = New-Object System.IO.BinaryWriter($fs)

    # ICONDIR header (6 bytes)
    $bw.Write([uint16]0) # Reserved
    $bw.Write([uint16]1) # Type 1 = ICO
    $bw.Write([uint16]$images.Count) # Count

    $offset = 6 + ($images.Count * 16)
    foreach ($img in $images) {
        $sz = $img[0]
        $bytes = $img[1]
        $w = if ($sz -ge 256) { 0 } else { [byte]$sz }
        $h = if ($sz -ge 256) { 0 } else { [byte]$sz }
        $bw.Write([byte]$w)
        $bw.Write([byte]$h)
        $bw.Write([byte]0) # Color count
        $bw.Write([byte]0) # Reserved
        $bw.Write([uint16]1) # Color planes
        $bw.Write([uint16]32) # Bits per pixel
        $bw.Write([uint32]$bytes.Length) # Size of image data
        $bw.Write([uint32]$offset) # Offset
        $offset += $bytes.Length
    }

    foreach ($img in $images) {
        $bw.Write($img[1])
    }

    $bw.Flush()
    $bw.Close()
    $fs.Close()
}

$inputPath = (Resolve-Path "packages/electron/electron/assets/icon.png").Path
$outputPath = Join-Path (Split-Path $inputPath) "icon.ico"
Convert-PngToIco -InputPng $inputPath -OutputIco $outputPath
Write-Host "Generated icon.ico at $outputPath"

$webPublic = Join-Path (Resolve-Path "web").Path "public"
if (-not (Test-Path $webPublic)) { New-Item -ItemType Directory -Path $webPublic | Out-Null }
Convert-PngToIco -InputPng $inputPath -OutputIco (Join-Path $webPublic "favicon.ico")
Copy-Item $inputPath (Join-Path $webPublic "icon.png") -Force
Write-Host "Copied to web/public"

$rootPublic = (Resolve-Path "public").Path
Convert-PngToIco -InputPng $inputPath -OutputIco (Join-Path $rootPublic "favicon.ico")
Copy-Item $inputPath (Join-Path $rootPublic "icon.png") -Force
Write-Host "Copied to public/"
