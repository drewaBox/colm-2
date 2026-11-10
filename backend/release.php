<?php
// Release of documents: expected release date, payment when claiming, the 14-day cancellation rule and the "ready for pickup" email.
// All the rules live here, so api/requests.php, api/release.php and tools/cancel_overdue.php use the same code.
require_once __DIR__ . '/database.php';
require_once __DIR__ . '/workflow.php';
require_once __DIR__ . '/audit.php';
require_once __DIR__ . '/mailer.php';

const CLAIM_DAYS = 14;               // a ready document that is neither paid nor claimed after this many days is cancelled
const MAX_RELEASE_DAYS_AHEAD = 90;   // the expected release date cannot be set further than this from today

// The purposes a student can choose for each document. "Others" needs a written purpose.
// Keep this list the same as PURPOSE_CHOICES in frontend/js/newrequest.js (the server check is the one that counts).
const PURPOSE_CHOICES = ['Employment', 'Evaluation', 'Board Examination', 'Scholarship', 'Transfer to Another School', 'Further Studies', 'Personal Records'];

// ---------- Purpose ----------

// Returns the purpose text to save, or throws RuntimeException with the message for the student.
// "Others" + "Birthday gift" saves "Birthday gift": the request shows the real purpose, never only "Others".
function resolve_item_purpose($choice, $other, $documentName) {
    $choice = clean_text($choice, 255);
    $other = clean_text($other, 255);
    if ($choice === 'Others') {
        if (mb_strlen($other) < 3 || !preg_match('/[A-Za-z]{2}/', $other)) {
            throw new RuntimeException("Please write the purpose for \"$documentName\" when you choose Others.");
        }
        return $other;
    }
    if (!in_array($choice, PURPOSE_CHOICES, true)) throw new RuntimeException("Choose a purpose for \"$documentName\".");
    return $choice;
}

// ---------- Dates ----------

// The last day the student can still pay and claim. After this day (23:59:59) the system cancels the request.
// The 14 days start when the document became ready, or on the expected release date when that date is later
// (the student cannot claim before that date, so the period must not run before it).
function claim_deadline($request) {
    if (empty($request['ready_at'])) return null;
    $start = new DateTimeImmutable(substr($request['ready_at'], 0, 10));
    if (!empty($request['expected_release_date'])) {
        $expected = new DateTimeImmutable($request['expected_release_date']);
        if ($expected > $start) $start = $expected;
    }
    return $start->modify('+' . CLAIM_DAYS . ' days')->setTime(23, 59, 59);
}

// Returns '' when the date is fine, or the message to show.
function release_date_problem($value, $request) {
    $value = trim((string)$value);
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
    if (!$date || $date->format('Y-m-d') !== $value) return 'Enter a valid date.';
    $today = new DateTimeImmutable('today');
    if ($date < $today) return 'The expected release date cannot be in the past.';
    if ($date > $today->modify('+' . MAX_RELEASE_DAYS_AHEAD . ' days')) return 'The expected release date cannot be more than ' . MAX_RELEASE_DAYS_AHEAD . ' days from today.';
    if ((int)$date->format('N') >= 6 && env('RELEASE_ALLOW_WEEKENDS', '') !== '1') return 'Choose a weekday (Monday to Friday). Set RELEASE_ALLOW_WEEKENDS=1 in .env if the office releases on weekends.';
    $created = new DateTimeImmutable(substr((string)($request['created_at'] ?? 'today'), 0, 10));
    if ($date < $created) return 'The expected release date cannot be before the request date.';
    return '';
}

// ---------- Expected release date (Registrar / Admin) ----------

function set_expected_release_date($requestId, $value, $user) {
    $pdo = db();
    try {
        $pdo->beginTransaction();
        $request = fetch_one('SELECT id, tracking_no, student_id, status, created_at, expected_release_date FROM requests WHERE id = ? FOR UPDATE', [$requestId]);
        if (!$request) throw new RuntimeException('Request not found.');
        if (!in_array($request['status'], ['FOR_REVIEW', 'NEEDS_CORRECTION', 'PROCESSING', 'READY'], true)) {
            throw new RuntimeException('The release date can be set after the request reached review, and not after it is completed, rejected or cancelled.');
        }
        $problem = release_date_problem($value, $request);
        if ($problem !== '') throw new RuntimeException($problem);
        $value = trim((string)$value);
        $dateChanged = $request['expected_release_date'] !== $value;
        $statusChanged = $request['status'] === 'FOR_REVIEW';
        if (!$dateChanged && !$statusChanged) {
            $pdo->commit();
            return ['changed' => false, 'tracking_no' => $request['tracking_no']];
        }

        if ($dateChanged) query('UPDATE requests SET expected_release_date = ? WHERE id = ?', [$value, $requestId]);
        if ($statusChanged) query("UPDATE requests SET status = 'PROCESSING' WHERE id = ? AND status = 'FOR_REVIEW'", [$requestId]);
        $note = $dateChanged
            ? 'Expected release date ' . ($request['expected_release_date'] ? 'changed from ' . $request['expected_release_date'] . ' to ' : 'set to ') . $value . '.'
            : '';
        if ($statusChanged) $note = trim($note . ' Request moved to Preparing.');
        add_history($requestId, $request['status'], $statusChanged ? 'PROCESSING' : $request['status'], $user['id'], $note);
        if ($dateChanged) {
            audit_log('release_date_set', 'request', $requestId, $requestId, $user['id'], $request['expected_release_date'], $value, $note);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    $resultingStatus = $statusChanged ? 'PROCESSING' : $request['status'];
    $emailStatus = 'skipped';
    if ($dateChanged) {
        add_notification((int)$request['student_id'], $requestId, 'Expected release date',
            "Request {$request['tracking_no']}: your expected release date is " . date('F j, Y', strtotime($value)) . '.', 'info');
    }
    if ($statusChanged) {
        add_notification((int)$request['student_id'], $requestId, 'Request preparing',
            "Request {$request['tracking_no']} is now being prepared.", 'info');
    }
    if ($dateChanged && in_array($resultingStatus, ['PROCESSING', 'READY'], true)) {
        $emailStatus = send_processing_date_email($requestId);
    }
    return ['changed' => true, 'tracking_no' => $request['tracking_no'], 'email_status' => $emailStatus];
}

// ---------- Payment when claiming ----------

function new_payment_receipt_no() {
    for ($i = 0; $i < 10; $i++) {
        $number = 'OR-' . date('Ymd') . '-' . random_int(1000, 9999);
        if (!fetch_one('SELECT id FROM payments WHERE receipt_no = ?', [$number])) return $number;
    }
    throw new RuntimeException('Could not create a receipt number.');
}

// Is the payment step satisfied so the request may go on? UPON_RELEASE requests are paid at the end (confirm_payment_at_release),
// so they do not need a receipt before processing. Older ADVANCE requests keep the receipt rule they had.
function payment_gate_ok($request, $staffId) {
    if (($request['payment_term'] ?? 'ADVANCE') === 'UPON_RELEASE') return true;
    require_once __DIR__ . '/receipt_security.php';
    return auto_confirm_receipt_payment($request, $staffId);
}

// The Registrar / Admin received the money when the student came to claim. Idempotent: pressing the button twice, or two staff at the same time,
// creates ONE payment (the request row is locked and payments.request_id is UNIQUE).
function confirm_payment_at_release($requestId, $user, $officialReceiptNo = '') {
    $officialReceiptNo = strtoupper(trim((string)$officialReceiptNo));
    if ($officialReceiptNo !== '' && !preg_match('/^[A-Z0-9][A-Z0-9-]{3,39}$/', $officialReceiptNo)) {
        throw new RuntimeException('The Official Receipt No. may only have letters, numbers and dashes (4 to 40 characters).');
    }
    $pdo = db();
    try {
        $pdo->beginTransaction();
        $request = fetch_one('SELECT id, tracking_no, student_id, status, payment_status, payment_term, payment_method, total_amount FROM requests WHERE id = ? FOR UPDATE', [$requestId]);
        if (!$request) throw new RuntimeException('Request not found.');
        if ($request['payment_term'] !== 'UPON_RELEASE') throw new RuntimeException('This older request is paid with an uploaded receipt. Review the receipt on the Payment Receipts page.');
        if ($request['payment_status'] === 'Paid' && $request['status'] === 'COMPLETED') {
            $pdo->commit();
            return ['already' => true, 'completed' => true, 'tracking_no' => $request['tracking_no']];
        }
        if ($request['payment_status'] === 'Refunded') throw new RuntimeException('This payment was already refunded. Ask an Admin to correct the record.');
        if ($request['status'] !== 'READY') {
            throw new RuntimeException($request['status'] === 'CANCELLED'
                ? 'This request was cancelled. The student must submit a new request.'
                : 'Payment is taken when the document is ready for release. This request is "' . (STATUS_LABELS[$request['status']] ?? $request['status']) . '".');
        }
        if ((float)$request['total_amount'] <= 0) throw new RuntimeException('There is nothing to pay for this request.');
        $paymentId = null;
        $receiptNo = '';
        if ($request['payment_status'] !== 'Paid') {
            if ($officialReceiptNo !== '' && fetch_one('SELECT id FROM payments WHERE reference_no = ?', [$officialReceiptNo])) {
                throw new RuntimeException("The Official Receipt No. $officialReceiptNo was already used for another payment.");
            }
            $receiptNo = new_payment_receipt_no();
            query('INSERT INTO payments (request_id, receipt_no, amount, method, reference_no, received_by) VALUES (?, ?, ?, ?, ?, ?)',
                [$requestId, $receiptNo, $request['total_amount'], $request['payment_method'] ?: 'Cash', $officialReceiptNo !== '' ? $officialReceiptNo : null, $user['id']]);
            $paymentId = (int)$pdo->lastInsertId();
            query("UPDATE requests SET payment_status = 'Paid' WHERE id = ?", [$requestId]);
            $note = "Payment received when claiming ($receiptNo" . ($officialReceiptNo !== '' ? ", O.R. $officialReceiptNo" : '') . ').';
            audit_log('payment_confirmed', 'payment', $paymentId, $requestId, $user['id'], 'Unpaid', 'Paid', $note . ' Amount ' . $request['total_amount']);
        } else {
            $note = 'Payment was already recorded; document released when claiming.';
        }
        $request['payment_status'] = 'Paid';
        $gate = release_gate_problems($request, 'COMPLETED', $user['id']);
        if ($gate) throw new RuntimeException(implode(' ', $gate));
        change_status($requestId, 'COMPLETED', $user['id'], $note);
        audit_log('status_completed', 'request', $requestId, $requestId, $user['id'], 'READY', 'COMPLETED', $note);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        if ($e instanceof PDOException && (string)$e->getCode() === '23000') {
            // a second payment row for this request (or this O.R. number) was refused by the database
            throw new RuntimeException('This payment was already recorded.');
        }
        throw $e;
    }
    return ['already' => $request['payment_status'] === 'Paid' && $paymentId === null, 'completed' => true, 'tracking_no' => $request['tracking_no']];
}

// ---------- Automatic cancellation (14 days) ----------

// Cancels READY requests that are not paid and not claimed after the claim period. Safe to run any number of times
// (cron every hour, or the Admin button): each request is locked and checked again before it is changed.
// Never touches: paid, refunded, completed, rejected, still processing, or anything that is not READY.
// $dryRun = true only lists what would be cancelled.
function cancel_overdue_requests($dryRun = false, $now = null) {
    $now = $now ?: new DateTimeImmutable('now');
    // Rough filter in SQL (a request cannot be overdue before it was ready for CLAIM_DAYS days); the exact deadline is checked per request.
    $cutoff = $now->modify('-' . CLAIM_DAYS . ' days')->format('Y-m-d H:i:s');
    $candidates = fetch_all("SELECT id FROM requests WHERE status = 'READY' AND payment_status = 'Unpaid' AND ready_at IS NOT NULL AND ready_at <= ? ORDER BY id", [$cutoff]);
    $cancelled = []; $skipped = 0;
    foreach ($candidates as $candidate) {
        $pdo = db();
        try {
            $pdo->beginTransaction();
            $request = fetch_one('SELECT id, tracking_no, student_id, status, payment_status, ready_at, expected_release_date FROM requests WHERE id = ? FOR UPDATE', [$candidate['id']]);
            $deadline = $request ? claim_deadline($request) : null;
            $stillOverdue = $request && $request['status'] === 'READY' && $request['payment_status'] === 'Unpaid'
                && !fetch_one('SELECT id FROM payments WHERE request_id = ?', [$request['id']])
                && $deadline && $now > $deadline;
            if (!$stillOverdue) { $pdo->commit(); $skipped++; continue; }
            if ($dryRun) { $pdo->commit(); $cancelled[] = $request['tracking_no']; continue; }

            $reason = 'Automatically cancelled: not paid or claimed within ' . CLAIM_DAYS . ' days after it was ready (claim deadline ' . $deadline->format('Y-m-d') . '). Submit a new request to continue.';
            $changed = query("UPDATE requests SET status = 'CANCELLED', cancelled_at = ?, cancel_reason = ?, registrar_remarks = ? WHERE id = ? AND status = 'READY' AND payment_status = 'Unpaid'",
                [$now->format('Y-m-d H:i:s'), mb_substr($reason, 0, 255), $reason, $request['id']])->rowCount();
            if (!$changed) { $pdo->commit(); $skipped++; continue; }
            add_history((int)$request['id'], 'READY', 'CANCELLED', null, $reason);
            audit_log('auto_cancel', 'request', (int)$request['id'], (int)$request['id'], null, 'READY', 'CANCELLED', $reason);
            $pdo->commit();
            add_notification((int)$request['student_id'], (int)$request['id'], 'Request cancelled',
                "Request {$request['tracking_no']} was cancelled because it was not paid or claimed within " . CLAIM_DAYS . ' days. Please submit a new request.', 'error');
            $cancelled[] = $request['tracking_no'];
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            write_log('Automatic cancellation failed for request ' . $candidate['id'] . ': ' . $e->getMessage());   // one bad request must not stop the others
            $skipped++;
        }
    }
    return ['cancelled' => $cancelled, 'skipped' => $skipped, 'dry_run' => $dryRun];
}

// Admin only: a documented correction of a cancelled request (for example the student came on day 15 with a valid reason).
// The claim period starts again from now. The cancellation stays in the history.
function reinstate_request($requestId, $reason, $user) {
    $reason = clean_text($reason, 255);
    if (mb_strlen($reason) < 5) throw new RuntimeException('Write the reason for the correction (at least 5 characters).');
    $pdo = db();
    try {
        $pdo->beginTransaction();
        $request = fetch_one('SELECT id, tracking_no, student_id, status FROM requests WHERE id = ? FOR UPDATE', [$requestId]);
        if (!$request) throw new RuntimeException('Request not found.');
        if ($request['status'] !== 'CANCELLED') throw new RuntimeException('Only a cancelled request can be reinstated.');
        $now = date('Y-m-d H:i:s');
        query("UPDATE requests SET status = 'READY', ready_at = ?, cancelled_at = NULL, registrar_remarks = ? WHERE id = ? AND status = 'CANCELLED'", [$now, 'Reinstated: ' . $reason, $requestId]);
        add_history($requestId, 'CANCELLED', 'READY', $user['id'], 'Reinstated by an Admin: ' . $reason);
        audit_log('reinstate', 'request', $requestId, $requestId, $user['id'], 'CANCELLED', 'READY', $reason);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    add_notification((int)$request['student_id'], $requestId, 'Request reinstated', "Request {$request['tracking_no']} is ready again. Please claim it within " . CLAIM_DAYS . ' days.', 'success');
    send_ready_email($requestId);
    return ['tracking_no' => $request['tracking_no']];
}

// ---------- "Ready for pickup" email ----------

// Sends the email at most once for each time a request became ready (email_log has UNIQUE request + kind + ready time).
// A failed email is saved as FAILED and retried up to 3 times by a later call; it never changes the request status and never throws.
// Returns 'sent', 'failed', 'duplicate', 'skipped' or 'error'.
function send_ready_email($requestId) {
    try {
        $r = fetch_one('SELECT r.id, r.tracking_no, r.status, r.ready_at, r.expected_release_date, r.payment_status, r.payment_term, r.total_amount, u.full_name, u.email
                        FROM requests r JOIN users u ON u.id = r.student_id WHERE r.id = ?', [$requestId]);
        if (!$r || $r['status'] !== 'READY' || !$r['ready_at']) return 'skipped';
        $eventKey = date('YmdHis', strtotime($r['ready_at']));
        $email = trim((string)$r['email']);

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            query("INSERT IGNORE INTO email_log (request_id, kind, event_key, to_email, status, attempts, error_message) VALUES (?, 'READY', ?, '', 'FAILED', 1, 'The student has no valid email address.')", [$requestId, $eventKey]);
            return 'failed';
        }
        $inserted = query("INSERT IGNORE INTO email_log (request_id, kind, event_key, to_email, status, attempts) VALUES (?, 'READY', ?, ?, 'PENDING', 1)",
            [$requestId, $eventKey, $email])->rowCount();
        if (!$inserted) {
            // Already tried before. Only a FAILED email (or one stuck as PENDING for 10 minutes) is tried again, 3 times at most.
            // The UPDATE is atomic: if two processes get here together only one of them wins.
            $retry = query("UPDATE email_log SET status = 'PENDING', attempts = attempts + 1, to_email = ?
                            WHERE request_id = ? AND kind = 'READY' AND event_key = ? AND attempts < 3
                              AND (status = 'FAILED' OR (status = 'PENDING' AND created_at < ?))",
                [$email, $requestId, $eventKey, date('Y-m-d H:i:s', time() - 600)])->rowCount();
            if (!$retry) return 'duplicate';
        }

        $documents = array_map(fn($i) => $i['name'] . ' x ' . $i['quantity'],
            fetch_all('SELECT d.name, i.quantity FROM request_items i JOIN documents d ON d.id = i.document_id WHERE i.request_id = ? ORDER BY i.id', [$requestId]));
        $deadline = claim_deadline($r);
        $payNote = $r['payment_term'] === 'UPON_RELEASE' && $r['payment_status'] !== 'Paid' && (float)$r['total_amount'] > 0
            ? 'Please bring PHP ' . number_format((float)$r['total_amount'], 2) . ' - you pay when you claim your document.' : '';
        [$ok, $error] = send_ready_for_pickup_email($email, $r['full_name'], $r['tracking_no'], $documents,
            $r['expected_release_date'] ? date('F j, Y', strtotime($r['expected_release_date'])) : '',
            $deadline ? $deadline->format('F j, Y') : '', $payNote);

        query('UPDATE email_log SET status = ?, sent_at = ?, error_message = ? WHERE request_id = ? AND kind = \'READY\' AND event_key = ?',
            [$ok ? 'SENT' : 'FAILED', $ok ? date('Y-m-d H:i:s') : null, $ok ? null : mb_substr((string)$error, 0, 255), $requestId, $eventKey]);
        return $ok ? 'sent' : 'failed';
    } catch (Throwable $e) {
        write_log('Ready-for-pickup email problem for request ' . $requestId . ': ' . $e->getMessage());
        return 'error';
    }
}


// Notify the student of the expected date once a request is processing; a changed date gets a distinct email event.
// A request cannot send this message without a saved release date. Failed sends are logged and can be retried.
function send_processing_date_email($requestId) {
    try {
        $r = fetch_one('SELECT r.id, r.tracking_no, r.status, r.expected_release_date, u.full_name, u.email
                        FROM requests r JOIN users u ON u.id = r.student_id WHERE r.id = ?', [$requestId]);
        if (!$r || !in_array($r['status'], ['PROCESSING', 'READY'], true) || empty($r['expected_release_date'])) return 'skipped';
        $dateChange = fetch_one("SELECT id FROM audit_log
                                 WHERE request_id = ? AND action = 'release_date_set' AND new_value = ?
                                 ORDER BY id DESC LIMIT 1", [$requestId, $r['expected_release_date']]);
        $eventKey = $dateChange ? 'DATE-' . $dateChange['id'] : 'DATE-' . substr(sha1($r['expected_release_date']), 0, 32);
        $email = trim((string)$r['email']);

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            query("INSERT IGNORE INTO email_log (request_id, kind, event_key, to_email, status, attempts, error_message) VALUES (?, 'PROCESSING_DATE', ?, '', 'FAILED', 1, 'The student has no valid email address.')", [$requestId, $eventKey]);
            return 'failed';
        }
        $inserted = query("INSERT IGNORE INTO email_log (request_id, kind, event_key, to_email, status, attempts) VALUES (?, 'PROCESSING_DATE', ?, ?, 'PENDING', 1)",
            [$requestId, $eventKey, $email])->rowCount();
        if (!$inserted) {
            $retry = query("UPDATE email_log SET status = 'PENDING', attempts = attempts + 1, to_email = ?
                            WHERE request_id = ? AND kind = 'PROCESSING_DATE' AND event_key = ? AND attempts < 3
                              AND (status = 'FAILED' OR (status = 'PENDING' AND created_at < ?))",
                [$email, $requestId, $eventKey, date('Y-m-d H:i:s', time() - 600)])->rowCount();
            if (!$retry) return 'duplicate';
        }

        $documents = implode(', ', array_map(
            fn($item) => $item['name'] . ' × ' . $item['quantity'],
            fetch_all('SELECT d.name, i.quantity FROM request_items i JOIN documents d ON d.id = i.document_id WHERE i.request_id = ? ORDER BY i.id', [$requestId])
        ));
        $trackingUrl = app_base_url($_SERVER['SCRIPT_NAME'] ?? '/api/requests.php') . '/frontend/index.html?track=' . rawurlencode($r['tracking_no']);
        $values = [
            'student_name' => $r['full_name'],
            'tracking_no' => $r['tracking_no'],
            'documents' => $documents,
            'expected_release_date' => date('F j, Y', strtotime($r['expected_release_date'])),
            'tracking_url' => $trackingUrl,
        ];
        $template = processing_date_email_template();
        $subject = preg_replace_callback('/{{\s*([a-z_]+)\s*}}/', fn($match) => $values[$match[1]] ?? $match[0], $template['subject']);
        $subject = trim(preg_replace('/[\r\n]+/', ' ', $subject));
        $html = render_processing_date_email_body($template['body'], $values);
        $text = preg_replace_callback('/{{\s*([a-z_]+)\s*}}/', function ($match) use ($values) {
            if ($match[1] === 'tracking_url') return 'Track My Request: ' . $values['tracking_url'];
            return $values[$match[1]] ?? $match[0];
        }, $template['body']);
        [$ok, $error] = mail_send(
            $email,
            $r['full_name'],
            $subject,
            mail_layout('Expected release date', '#0b4a36', "Request {$r['tracking_no']}: your expected release date is " . $values['expected_release_date'] . '.', $html),
            $text,
            'processing release date'
        );
        query('UPDATE email_log SET status = ?, sent_at = ?, error_message = ? WHERE request_id = ? AND kind = \'PROCESSING_DATE\' AND event_key = ?',
            [$ok ? 'SENT' : 'FAILED', $ok ? date('Y-m-d H:i:s') : null, $ok ? null : mb_substr((string)$error, 0, 255), $requestId, $eventKey]);
        return $ok ? 'sent' : 'failed';
    } catch (Throwable $e) {
        write_log('Processing-date email problem for request ' . $requestId . ': ' . $e->getMessage());
        return 'error';
    }
}

// ---------- "Request rejected" email ----------

// Same safety rules as send_ready_email(): the request is already saved as REJECTED, so a failed email is only logged
// (email_log, FAILED) and never changes the request or throws. REJECTED is final, so there is one email per request ('final').
// Returns 'sent', 'failed', 'duplicate', 'skipped' or 'error'.
function send_rejected_email($requestId) {
    try {
        $r = fetch_one('SELECT r.id, r.tracking_no, r.status, r.registrar_remarks, r.payment_status, u.full_name, u.email
                        FROM requests r JOIN users u ON u.id = r.student_id WHERE r.id = ?', [$requestId]);
        if (!$r || $r['status'] !== 'REJECTED') return 'skipped';
        $email = trim((string)$r['email']);

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            query("INSERT IGNORE INTO email_log (request_id, kind, event_key, to_email, status, attempts, error_message) VALUES (?, 'REJECTED', 'final', '', 'FAILED', 1, 'The student has no valid email address.')", [$requestId]);
            return 'failed';
        }
        $inserted = query("INSERT IGNORE INTO email_log (request_id, kind, event_key, to_email, status, attempts) VALUES (?, 'REJECTED', 'final', ?, 'PENDING', 1)",
            [$requestId, $email])->rowCount();
        if (!$inserted) {
            $retry = query("UPDATE email_log SET status = 'PENDING', attempts = attempts + 1, to_email = ?
                            WHERE request_id = ? AND kind = 'REJECTED' AND event_key = 'final' AND attempts < 3
                              AND (status = 'FAILED' OR (status = 'PENDING' AND created_at < ?))",
                [$email, $requestId, date('Y-m-d H:i:s', time() - 600)])->rowCount();
            if (!$retry) return 'duplicate';
        }

        $documents = array_map(fn($i) => $i['name'] . ' x ' . $i['quantity'],
            fetch_all('SELECT d.name, i.quantity FROM request_items i JOIN documents d ON d.id = i.document_id WHERE i.request_id = ? ORDER BY i.id', [$requestId]));
        $reason = trim((string)$r['registrar_remarks']) !== '' ? trim((string)$r['registrar_remarks']) : 'No reason was recorded. Please contact the Registrar\'s Office.';
        $payNote = $r['payment_status'] === 'Paid'
            ? 'Your payment was already received for this request. Please contact the Registrar\'s Office so the payment can be resolved.' : '';
        [$ok, $error] = send_request_rejected_email($email, $r['full_name'], $r['tracking_no'], $documents, $reason, $payNote);

        query('UPDATE email_log SET status = ?, sent_at = ?, error_message = ? WHERE request_id = ? AND kind = \'REJECTED\' AND event_key = \'final\'',
            [$ok ? 'SENT' : 'FAILED', $ok ? date('Y-m-d H:i:s') : null, $ok ? null : mb_substr((string)$error, 0, 255), $requestId]);
        return $ok ? 'sent' : 'failed';
    } catch (Throwable $e) {
        write_log('Rejected email problem for request ' . $requestId . ': ' . $e->getMessage());
        return 'error';
    }
}


// ---------- One release gate for everybody ----------

// The ONE place that says whether a request may move to READY or COMPLETED. Returns a list of problems (empty = allowed).
// set_request_status() and any other endpoint must use this, so two screens can never disagree.
//   READY:     every uploaded requirement verified, soft copies ready when the student chose soft copy, and (older pay-first requests) the receipt checked.
//   COMPLETED: the request is READY (or already being released) and the payment is recorded when there is something to pay.
function release_gate_problems($request, $target, $staffId) {
    $problems = [];
    $id = (int)$request['id'];
    if ($target === 'READY') {
        if (in_array($request['status'], ['REJECTED', 'CANCELLED', 'COMPLETED', 'NEEDS_CORRECTION'], true)) {
            $problems[] = 'This request is ' . strtolower(STATUS_LABELS[$request['status']] ?? $request['status']) . ' and cannot be made ready.';
            return $problems;
        }
        $notVerified = (int)fetch_one("SELECT COUNT(*) AS c FROM request_files WHERE request_id = ? AND kind = 'requirement' AND is_current = 1 AND review_status <> 'Verified'", [$id])['c'];
        if ($notVerified > 0) $problems[] = 'Please verify every uploaded document first.';
        if (!payment_gate_ok($request, $staffId)) $problems[] = 'The payment receipt has not passed the security check yet. Review it first on the Payment Receipts page.';
        if (format_wants_softcopy($request['release_method'])) {
            $notReady = (int)fetch_one("SELECT COUNT(*) AS c FROM request_items WHERE request_id = ? AND softcopy_status <> 'READY'", [$id])['c'];
            if ($notReady > 0) $problems[] = 'Upload the soft copy (PDF) of every document and mark it ready first.';
        }
    } elseif ($target === 'COMPLETED') {
        if ((float)$request['total_amount'] > 0) {
            if ($request['payment_status'] === 'Refunded') $problems[] = 'This payment was refunded, so the document cannot be released.';
            elseif ($request['payment_status'] !== 'Paid' || !fetch_one('SELECT id FROM payments WHERE request_id = ? AND refunded_at IS NULL', [$id])) {
                $problems[] = 'Record the payment before releasing the document.';
            }
        }
    }
    return $problems;
}