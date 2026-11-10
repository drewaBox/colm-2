<?php
// The electronic signature (uploaded by the student with a transparent background, checked in the browser and again here) on the credential request form (TOR, Form 137, Honorable Dismissal).
// The browser sends the drawing as a PNG data URL. We never trust it: it is decoded, size-checked, checked for real ink,
// redrawn with GD (so nothing hidden inside the file survives) and saved as a normal private file. One signature per request, never updated.
require_once __DIR__ . '/files.php';

const SIGNATURE_MAX_BYTES = 262144;     // 256 KB of PNG
const SIGNATURE_MIN_INK = 40;           // sampled dark, visible pixels needed so an empty picture is refused

// Returns the clean PNG bytes, or throws RuntimeException with a message for the student.
function signature_from_data_url($dataUrl) {
    $prefix = 'data:image/png;base64,';
    if (!is_string($dataUrl) || strncmp($dataUrl, $prefix, strlen($prefix)) !== 0) throw new RuntimeException('Upload your scanned signature.');
    $base64 = substr($dataUrl, strlen($prefix));
    if (strlen($base64) > (int)(SIGNATURE_MAX_BYTES * 4 / 3) + 16) throw new RuntimeException('The signature picture is too large. Remove it and upload your signature again.');
    $png = base64_decode($base64, true);
    if ($png === false || strlen($png) > SIGNATURE_MAX_BYTES || strncmp($png, "\x89PNG\r\n\x1a\n", 8) !== 0) throw new RuntimeException('The signature is not a valid picture. Remove it and upload your signature again.');
    $info = @getimagesizefromstring($png);
    if (!$info || $info[2] !== IMAGETYPE_PNG || $info[0] < 100 || $info[1] < 40 || $info[0] > 1200 || $info[1] > 600) {
        throw new RuntimeException('The signature picture has the wrong size. Remove it and upload your signature again.');
    }
    if (!function_exists('imagecreatefromstring')) throw new RuntimeException('The server cannot check the signature (PHP GD is missing).');
    if (!image_fits_in_memory($info[0], $info[1])) throw new RuntimeException('The signature picture is too large. Remove it and upload your signature again.');
    $source = @imagecreatefromstring($png);
    if (!$source) throw new RuntimeException('The signature is not a valid picture. Remove it and upload your signature again.');

    // Automatic background check (same rule as the browser): transparent background = Verified, any background = Rejected.
    if (!imageistruecolor($source)) imagepalettetotruecolor($source);
    $width = imagesx($source); $height = imagesy($source);
    $edge = 0; $edgeClear = 0; $edgeLight = 0;
    $edgePoint = function ($x, $y) use ($source, &$edge, &$edgeClear, &$edgeLight) {
        $c = imagecolorat($source, $x, $y); $edge++;
        if ((($c >> 24) & 127) > 120) $edgeClear++;                                   // GD alpha: 127 = fully transparent
        elseif ((($c >> 16) & 255) + (($c >> 8) & 255) + ($c & 255) > 600) $edgeLight++;  // opaque and nearly white
    };
    for ($x = 0; $x < $width; $x++) { $edgePoint($x, 0); $edgePoint($x, $height - 1); }
    for ($y = 1; $y < $height - 1; $y++) { $edgePoint(0, $y); $edgePoint($width - 1, $y); }
    $clear = 0; $ink = 0; $sampled = 0;
    for ($y = 0; $y < $height; $y += 2) {
        for ($x = 0; $x < $width; $x += 2) {
            $c = imagecolorat($source, $x, $y); $sampled++;
            $alpha = ($c >> 24) & 127;
            if ($alpha > 120) { $clear++; continue; }
            if ($alpha < 64 && (($c >> 16) & 255) + (($c >> 8) & 255) + ($c & 255) < 450) $ink++;   // visible and clearly dark
        }
    }
    if ($edgeClear / max(1, $edge) < 0.9 || $clear / max(1, $sampled) < 0.2) {
        imagedestroy($source);
        if ($clear / max(1, $sampled) < 0.02 && $edgeLight / max(1, $edge) > 0.5) throw new RuntimeException('Rejected: white background found. Upload your signature with a transparent background.');
        throw new RuntimeException('Rejected: the picture has a background. Upload your signature with a transparent background.');
    }
    if ($ink < SIGNATURE_MIN_INK) { imagedestroy($source); throw new RuntimeException('The signature is empty or too faint. Upload a clearer signature.'); }

    // Redraw into a fresh PNG (so nothing hidden inside the file survives). The transparent background is kept.
    $clean = imagecreatetruecolor($width, $height);
    imagealphablending($clean, false);
    imagesavealpha($clean, true);
    imagefill($clean, 0, 0, imagecolorallocatealpha($clean, 255, 255, 255, 127));
    imagecopy($clean, $source, 0, 0, 0, 0, $width, $height);
    imagedestroy($source);
    ob_start();
    imagepng($clean, null, 6);
    $output = ob_get_clean();
    imagedestroy($clean);
    if ($output === false || $output === '') throw new RuntimeException('The signature could not be saved. Please upload your signature again.');
    return $output;
}

// Writes the PNG as a private file and returns ['stored' => name, 'sha256' => hash]. The caller inserts the request_signatures row
// inside its own transaction and calls delete_stored_file() if that transaction fails.
function store_signature_png($png) {
    $tmp = tempnam(sys_get_temp_dir(), 'sig');
    if ($tmp === false || file_put_contents($tmp, $png) === false) throw new RuntimeException('The signature could not be saved. Please upload your signature again.');
    try {
        $stored = store_file($tmp, 'png');
    } finally {
        @unlink($tmp);
    }
    return ['stored' => $stored, 'sha256' => hash('sha256', $png)];
}