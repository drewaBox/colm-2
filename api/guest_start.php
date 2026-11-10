<?php
// POST {student_status: currently_enrolled|alumni, first_name, last_name, course, email [, code]}
//   currently_enrolled also sends student_id and year_level; alumni sends academic_year (the academic year graduated, e.g. 2024-2025) instead.
// Public entry for the landing page "Request a Document" form (no login page for requesters).
// Step 1 (no code): if this browser is already verified as the same student and email, go straight in; otherwise email a 6-digit code, or show a local-only code in development on localhost.
// NOTHING is created or opened until the code is verified.
// Step 2 (with code): the code proves the person owns the mailbox. Only then is the passwordless student record
//   created (or re-opened) and the session started. So knowing a Student ID and an email address is NOT enough to open someone's requests.
// Code rules: valid 1 minute (no new code is sent while one is still valid), one use, 5 wrong tries per code. Sending codes is not limited.
// Admin and registrar still use api/login.php.
require_once __DIR__ . '/../backend/auth.php';
require_once __DIR__ . '/../backend/students.php';
require_once __DIR__ . '/../backend/mailer.php';
require_once __DIR__ . '/../backend/ratelimit.php';
register_error_handlers();
require_method('POST');
start_session();

$in = read_json_body();
$first  = clean_text($in['first_name'] ?? '', 50);
$lastIn = clean_text($in['last_name'] ?? '', 50);
$course = clean_text($in['course'] ?? '', 80);
$statusIn = clean_text($in['student_status'] ?? '', 20);
if (!in_array($statusIn, ['currently_enrolled', 'alumni'], true)) fail('Please choose whether you are Currently Enrolled or an Alumni.', 422);
$gradYear = clean_text($in['academic_year'] ?? '', 9);
// Internally an alumni keeps the label 'Graduate / Alumni' (it is saved with the emailed code).
$yearLabel = $statusIn === 'alumni' ? 'Graduate / Alumni' : clean_text($in['year_level'] ?? '', 30);
$email  = strtolower(clean_text($in['email'] ?? '', 120));
$studentId = preg_replace('/[^0-9-]/', '', (string)($in['student_id'] ?? ''));
$studentId = mb_substr($studentId, 0, 30);

$years = ['First Year' => 1, 'Second Year' => 2, 'Third Year' => 3, 'Fourth Year' => 4, 'Graduate / Alumni' => null];
$isAlumni = $statusIn === 'alumni';

if ($first === '' || $lastIn === '' || $course === '' || $email === '') fail('Please fill out all fields.', 422);
if (!array_key_exists($yearLabel, $years) || (!$isAlumni && $yearLabel === 'Graduate / Alumni')) fail('Please choose your year level.', 422);
if ($isAlumni) {
    // Only the last 10 finished academic years (the school year starts in June).
    $lastAy = (int)date('n') >= 6 ? (int)date('Y') - 1 : (int)date('Y') - 2;
    $ayOk = preg_match('/^(\d{4})-(\d{4})$/', $gradYear, $ay)
        && (int)$ay[2] === (int)$ay[1] + 1
        && (int)$ay[1] >= $lastAy - 9
        && (int)$ay[1] <= $lastAy;
    if (!$ayOk) fail('Please choose a valid academic year you graduated. Only the last 10 years are allowed (' . ($lastAy - 9) . '-' . ($lastAy - 8) . ' to ' . $lastAy . '-' . ($lastAy + 1) . ').', 422);
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Please enter a valid email address.', 422);
if (!$isAlumni && $studentId === '') fail('Please enter your Student ID.', 422);
if ($isAlumni) $studentId = '';
if (level_of_course($course) === null) fail('Please choose a course from the list.', 422);

// Only students on the school record may continue. The message is the same whether the name or the ID is wrong,
// so nobody can use this form to find out which Student IDs exist.
const NOT_ON_RECORD = 'We could not find this name and Student ID in the school records. Please check the spelling or contact the Registrar.';
$registeredStudent = !$isAlumni ? find_registered_student($first, $lastIn, $studentId) : null;
if (!$isAlumni && !$registeredStudent) fail(NOT_ON_RECORD, 404);
if ($registeredStudent) {
    if (mb_strtolower(trim((string)$registeredStudent['course'])) !== mb_strtolower($course)) {
        fail('The selected course does not match the school records.', 422);
    }
}

// A currently enrolled student can only verify with the Gmail written in the master list, not with any other address.
const EMAIL_NOT_ON_RECORD = 'This email does not match the email in the school records. Please use the Gmail you gave the Registrar, or contact the Registrar.';
if ($registeredStudent && !email_matches_school_record($studentId, $registeredStudent['email'] ?? '', $email)) fail(EMAIL_NOT_ON_RECORD, 422);

// Same flood limit idea as the login: at most 100 requests from one address in 15 minutes (a school network shares one address).
$ip = request_ip();
$since = date('Y-m-d H:i:s', time() - 15 * 60);
$recent = (int)fetch_one('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND username = ? AND created_at > ?', [$ip, 'guest-start', $since])['c'];
if ($recent >= 100) fail('Too many attempts. Please try again in 15 minutes.', 429);
query('INSERT INTO login_attempts (ip, username, created_at) VALUES (?, ?, ?)', [$ip, 'guest-start', date('Y-m-d H:i:s')]);

// ---------- Email ownership check (OTP) ----------
$code = preg_replace('/\D/', '', (string)($in['code'] ?? ''));
$now = date('Y-m-d H:i:s');
$yearKey = $yearLabel;
if ($code === '') {
    // Already verified and still signed in as this same student with this same email (the request is not finished yet):
    // no new code is asked for. The code is only for a person who is not signed in yet.
    $cur = current_user();
    if ($cur && $cur['role'] === 'student' && strtolower(trim((string)$cur['email'])) === $email
        && (!$isAlumni
            ? ($registeredStudent && (int)$registeredStudent['id'] === (int)$cur['id'])
            : ($cur['student_no'] === null && strpos((string)$cur['username'], 'guest-') === 0))) {
        $same = fetch_one('SELECT id, username, full_name, email, role, student_no, must_change_password, password_changed_at FROM users WHERE id = ?', [$cur['id']]);
        session_regenerate_id(true);
        $_SESSION['user_id'] = (int)$cur['id'];
        $_SESSION['request_email'] = $email;
        unset($_SESSION['csrf']);
        json_response(['ok' => true, 'user' => user_for_browser($same), 'csrf' => csrf_token()]);
    }
    $mailer = configured_mailer();
    if (!$mailer) {
        if (env('MAIL_HOST', '') === 'smtp.gmail.com' && env('MAIL_USERNAME', '') !== '' && env('MAIL_PASSWORD', '') === '') {
            fail('Gmail is missing its App Password. Set MAIL_PASSWORD in .env to your 16-character Google App Password (not your regular Gmail password), then try again.', 503);
        }
        fail('The verification email is not configured. Check the Gmail settings in .env and run composer install.', 503);
    }
    // A code lasts 1 minute. While the last one is still valid (same details, tries left) no new one is sent: the person is told to use it.
    $payload = json_encode(['first' => $first, 'last' => $lastIn, 'course' => $course, 'year' => $yearKey, 'student_id' => $studentId, 'ay' => $gradYear], JSON_UNESCAPED_UNICODE);
    $live = fetch_one('SELECT expires_at, payload_json, attempts FROM guest_otps WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1', [$email, $now]);
    if ($live && (int)$live['attempts'] < 5 && $live['payload_json'] === $payload) {
        $wait = max(1, strtotime($live['expires_at']) - time());
        json_response(['ok' => true, 'otp_required' => true, 'already_sent' => true, 'retry_after' => $wait,
            'message' => 'A code was already sent to ' . $email . '. Enter it below. You can ask for a new one in ' . $wait . ' second' . ($wait === 1 ? '' : 's') . '.']);
    }
    $newCode = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    query('INSERT INTO guest_otps (email, student_no, code_hash, payload_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [$email, $studentId !== '' ? $studentId : null, hash('sha256', $email . '|' . $newCode), $payload, date('Y-m-d H:i:s', time() + 60), $now]);
    $otpId = (int)db()->lastInsertId();
    [$sent, $mailError] = mail_send($email, $first, 'Your COLM verification code',
        '<p>Hello ' . mail_h($first) . ',</p><p>Your verification code is <strong style="font-size:20px;letter-spacing:3px">' . $newCode . '</strong></p><p>It expires in 1 minute. If you did not ask for it, ignore this email.</p>',
        "Hello $first,\nYour COLM verification code is $newCode. It expires in 1 minute. If you did not ask for it, ignore this email.", 'guest code', $mailer);
    if (!$sent) {
        query('DELETE FROM guest_otps WHERE id = ?', [$otpId]);
        write_log('Guest verification email failed: ' . $mailError);
        fail('We could not send the verification email. Please try again later or contact the Registrar.', 503);
    }
    json_response(['ok' => true, 'otp_required' => true, 'message' => 'We sent a 6-digit code to ' . $email . '. Enter it below to continue. It expires in 1 minute.', 'retry_after' => 60]);
}

// Step 2: check the code. The latest unused, unexpired code for this email is the only one that counts.
// The 5-tries limit below belongs to ONE code; this one belongs to the email address, so new codes do not reset it.
if (!rate_limit_allow('otp-verify:' . $email, 30, 3600)) fail('Too many wrong codes for this email address. Please try again in an hour.', 429);
$otp = fetch_one('SELECT id, code_hash, payload_json, attempts FROM guest_otps WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1', [$email, $now]);
if (!$otp) fail('The code expired or was already used. Press Continue to get a new code.', 422);
if ((int)$otp['attempts'] >= 5) fail('Too many wrong codes. Press Continue later to get a new code.', 429);
query('UPDATE guest_otps SET attempts = attempts + 1 WHERE id = ?', [$otp['id']]);
if (!hash_equals($otp['code_hash'], hash('sha256', $email . '|' . $code))) fail('That code is not correct. Please check your email and try again.', 422);
// One use only: if two requests send the right code at the same moment, only one wins.
if (query('UPDATE guest_otps SET used_at = ? WHERE id = ? AND used_at IS NULL', [$now, $otp['id']])->rowCount() !== 1) fail('The code was already used. Press Continue to get a new code.', 422);
// From here on use what the verified code was issued for, not what the browser sends now.
$saved = json_decode($otp['payload_json'], true) ?: [];
$first = $saved['first'] ?? $first; $course = $saved['course'] ?? $course; $yearLabel = $saved['year'] ?? $yearLabel; $studentId = $saved['student_id'] ?? $studentId;
$lastName = $saved['last'] ?? '';
$gradYear = $saved['ay'] ?? '';
$isAlumni = $yearLabel === 'Graduate / Alumni';
$registeredStudent = !$isAlumni ? find_registered_student($first, $lastName, $studentId) : null;
if (!$isAlumni && !$registeredStudent) fail(NOT_ON_RECORD, 404);
if ($registeredStudent) {
    if (mb_strtolower(trim((string)$registeredStudent['course'])) !== mb_strtolower((string)($saved['course'] ?? $course))) {
        fail('The selected course does not match the school records.', 422);
    }
}

if ($registeredStudent && !email_matches_school_record($studentId, $registeredStudent['email'] ?? '', $email)) fail(EMAIL_NOT_ON_RECORD, 422);

$fullName = mb_substr($first . ' ' . $lastName, 0, 120);
$year = $years[$yearLabel] ?? null;
$status = $isAlumni ? 'alumni' : 'currently_enrolled';
$userId = 0;

try {
    $existing = $studentId !== ''
        ? fetch_one('SELECT id, username, email, is_active, is_approved, must_change_password FROM users WHERE student_no = ?', [$studentId])
        // alumni have no Student ID: the verified email is their identity, so the same person gets the same record every time
        : fetch_one("SELECT id, username, email, is_active, is_approved, must_change_password FROM users WHERE email = ? AND student_no IS NULL AND username LIKE 'guest-%' ORDER BY id LIMIT 1", [$email]);
    if ($existing) {
                $isGuest = strpos((string)$existing['username'], 'guest-') === 0;
        // The school record no longer holds an email, so any email that passed the code check is accepted.
        if (!$existing['is_active'] || !$existing['is_approved']) {
            fail('This student record is not available for verification.', 409);
        }
        $userId = (int)$existing['id'];
        // The email that passed the code check is the one the requester typed in the form: notices must reach THAT mailbox,
        // so it replaces an older email on the account (unless another account already uses it).
        if (strtolower(trim((string)$existing['email'])) !== $email && !fetch_one('SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1', [$email, $userId])) {
            query('UPDATE users SET email = ? WHERE id = ?', [$email, $userId]);
        }
        // Students enter with the emailed code, not a password: an imported account's default password must not lock them out.
        if (!empty($existing['must_change_password'])) {
            query('UPDATE users SET must_change_password = 0 WHERE id = ?', [$userId]);
        }
        if ($isGuest) {
            query('UPDATE users SET full_name = ? WHERE id = ?', [$fullName, $userId]);
            query('UPDATE students SET school_level = ?, course = ?, year_level = ?, status = ?, academic_year = ? WHERE user_id = ?',
                ['COLLEGE', $course, $year, $status, $isAlumni && $gradYear !== '' ? $gradYear : null, $userId]);
        }
    } else {
        $pdo = db();
        $pdo->beginTransaction();
        try {
            query('INSERT INTO users (username, password_hash, password_changed_at, full_name, email, role, student_no, must_change_password, is_active, is_approved) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, 0, 1, 1)',
                ['guest-' . bin2hex(random_bytes(8)), password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT),
                 $fullName, $email, 'student', $studentId !== '' ? $studentId : null]);
            $userId = (int)$pdo->lastInsertId();
            query('INSERT INTO students (user_id, school_level, course, year_level, status, academic_year) VALUES (?, ?, ?, ?, ?, ?)',
                [$userId, 'COLLEGE', $course, $year, $status, $isAlumni && $gradYear !== '' ? $gradYear : null]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }
} catch (Throwable $e) {
    write_log('guest_start failed: ' . $e->getMessage());
    fail('Could not start your request. Please try again.', 500);
}

$user = fetch_one('SELECT id, username, full_name, email, role, student_no, must_change_password, password_changed_at FROM users WHERE id = ?', [$userId]);
session_regenerate_id(true);
$_SESSION['user_id'] = $userId;
$_SESSION['request_email'] = $email;      // the verified email typed in the form: the request confirmation goes here
unset($_SESSION['csrf']);

json_response(['ok' => true, 'user' => user_for_browser($user), 'csrf' => csrf_token()]);