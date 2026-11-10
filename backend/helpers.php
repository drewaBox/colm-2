<?php
// Small helper functions used by every API file.

// A student can have at most this many open (not completed, rejected or cancelled) requests for the same document.
// Copies per document stay at 1 to 5.
const MAX_OPEN_REQUESTS_PER_DOCUMENT = 10;

// ---- Settings from the .env file ----
function env($key, $default = '') {
    static $values = null;
    if ($values === null) {
        $values = [];
        $file = __DIR__ . '/../.env';
        if (is_file($file)) {
            foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $line = trim($line);
                if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) continue;
                [$name, $value] = explode('=', $line, 2);
                $values[trim($name)] = trim($value, " \t\"'");
            }
        }
    }
    if (isset($values[$key]) && $values[$key] !== '') return $values[$key];
    $fromServer = getenv($key);
    return ($fromServer !== false && $fromServer !== '') ? $fromServer : $default;
}

// One timezone for the whole system (dates, the 14-day cancellation rule, release dates). Change APP_TIMEZONE in .env if needed.
date_default_timezone_set(env('APP_TIMEZONE', 'Asia/Manila'));

function is_production() {
    // Safe by default: when .env is missing or has no APP_ENV, the site behaves like a real (production) server.
    // For XAMPP development, .env must say APP_ENV=development (the .env.example file does).
    return env('APP_ENV', 'production') === 'production';
}

// The address of the computer that sent the request. Behind a reverse proxy / Cloudflare put TRUST_PROXY=1 in .env.
function request_ip() {
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    if (env('TRUST_PROXY', '') === '1' && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $parts = array_map('trim', explode(',', (string)$_SERVER['HTTP_X_FORWARDED_FOR']));
        $last = end($parts);                      // the last entry was added by our own proxy, so it cannot be faked
        if (filter_var($last, FILTER_VALIDATE_IP)) $ip = $last;
    }
    return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : 'unknown';
}

// ---- JSON answers ----
function json_response($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

// Stop and send an error message to the browser.
function fail($message, $status = 400, $extra = []) {
    json_response(array_merge(['ok' => false, 'error' => $message], $extra), $status);
}

// Read a JSON request body (for POST requests that are not file uploads).
function read_json_body() {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $data = json_decode($raw, true);
    if (!is_array($data)) fail('Invalid JSON.', 422);
    return $data;
}

function require_method($method) {
    if ($_SERVER['REQUEST_METHOD'] !== $method) fail('Method not allowed.', 405);
}

// Trim text and cut it to a maximum length.
function clean_text($value, $max = 255) {
    $value = trim((string)$value);
    return mb_substr($value, 0, $max);
}

function app_base_url($scriptName = null) {
    $configured = rtrim(trim((string)env('APP_URL', '')), '/');
    if ($configured !== '') return $configured;

    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
          || (env('TRUST_PROXY', '') === '1' && strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https');
    $scriptName = $scriptName ?? ($_SERVER['SCRIPT_NAME'] ?? '/');
    $basePath = rtrim(dirname(dirname($scriptName)), '/\\');
    return ($https ? 'https://' : 'http://') . ($_SERVER['HTTP_HOST'] ?? 'localhost') . $basePath;
}

function write_log($message) {
    $line = date('Y-m-d H:i:s') . ' ' . $message . "\n";
    @file_put_contents(__DIR__ . '/../storage/error.log', $line, FILE_APPEND);
}

function database_schema_is_compatible(PDO $pdo) {
    $table = $pdo->prepare('SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?');
    $table->execute(['users']);
    if ((int)$table->fetchColumn() === 0) return true;

    $column = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?');
    foreach (['username', 'full_name', 'role', 'student_no'] as $name) {
        $column->execute(['users', $name]);
        if ((int)$column->fetchColumn() === 0) return false;
    }
    return true;
}

// Turn unexpected PHP errors into a clean JSON 500 (no secrets shown in production).
function register_error_handlers() {
    ini_set('display_errors', '0');
    set_exception_handler(function ($e) {
        write_log(get_class($e) . ': ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
        $sqlState = $e instanceof PDOException ? (string)$e->getCode() : '';
        $driverCode = $e instanceof PDOException && isset($e->errorInfo[1]) ? (int)$e->errorInfo[1] : 0;
        if ($e instanceof PDOException && (in_array($sqlState, ['42S02', '42S22'], true) || in_array($driverCode, [1054, 1146], true))) {
            if (function_exists('db') && !database_schema_is_compatible(db())) {
                fail(
                    'This database uses a different schema from the application. Running php database/install.php will not fix it; the administrator must migrate or adapt the database before this workflow can be used.',
                    500,
                    ['code' => 'DATABASE_SCHEMA_INCOMPATIBLE']
                );
            }
            fail('The application database is missing a required table or column. The administrator must apply the matching schema update.', 500, ['code' => 'DATABASE_OUTDATED']);
        }
        fail(is_production() ? 'Server error. Please try again.' : 'Server error: ' . $e->getMessage(), 500);
    });
    // Fatal PHP errors (for example running out of memory) would otherwise give a blank page.
    register_shutdown_function(function () {
        $error = error_get_last();
        if ($error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true) && !headers_sent()) {
            write_log('Fatal: ' . $error['message'] . ' in ' . $error['file'] . ':' . $error['line']);
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['ok' => false, 'error' => 'The server could not process this request. Please try again with a smaller file.']);
        }
    });
}