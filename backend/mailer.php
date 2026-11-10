<?php
require_once __DIR__ . '/helpers.php';

function configured_mailer() {
    $autoload = __DIR__ . '/../vendor/autoload.php';
    if (!is_file($autoload)) {
        write_log('Email not sent: Composer dependencies are missing. Run composer install.');
        return null;
    }
    require_once $autoload;

    $host = env('MAIL_HOST', '');
    $from = env('MAIL_FROM', '');
    if ($host === '' || $from === '') {
        write_log('Email not sent: MAIL_HOST or MAIL_FROM is not configured.');
        return null;
    }
    if (env('MAIL_USERNAME', '') !== '' && env('MAIL_PASSWORD', '') === '') {
        write_log('Email not sent: MAIL_USERNAME is set but MAIL_PASSWORD is empty.');
        return null;
    }

    try {
        $mail = new PHPMailer\PHPMailer\PHPMailer(true);
        $mail->isSMTP();
        $mail->Host = $host;
        $mail->Port = (int)env('MAIL_PORT', '587');
        $mail->SMTPAuth = env('MAIL_USERNAME', '') !== '';
        if ($mail->SMTPAuth) {
            $mail->Username = env('MAIL_USERNAME', '');
            $mail->Password = env('MAIL_PASSWORD', '');
        }
        $encryption = strtolower(env('MAIL_ENCRYPTION', 'tls'));
        if ($encryption === 'ssl') $mail->SMTPSecure = PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_SMTPS;
        elseif ($encryption === 'tls') $mail->SMTPSecure = PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS;
        elseif ($encryption !== 'none') throw new RuntimeException('MAIL_ENCRYPTION must be tls, ssl, or none.');

        // Without a timeout PHP waits up to 5 minutes for a dead SMTP server and the whole page hangs.
        $mail->Timeout = max(3, (int)env('MAIL_TIMEOUT', '10'));
        $mail->CharSet = 'UTF-8';
        $mail->setFrom($from, env('MAIL_FROM_NAME', 'COLM Registrar'));
        // Optional: MAIL_REPLY_TO in .env (for example the registrar's real school address) so replies go to a person.
        $replyTo = trim((string)env('MAIL_REPLY_TO', ''));
        if ($replyTo !== '' && filter_var($replyTo, FILTER_VALIDATE_EMAIL)) $mail->addReplyTo($replyTo, env('MAIL_FROM_NAME', 'COLM Registrar'));
        $mail->XMailer = ' ';                                          // do not advertise "PHPMailer" in the email headers
        $mail->addCustomHeader('Auto-Submitted', 'auto-generated');    // tells mail servers this is an automatic system message
        return $mail;
    } catch (Throwable $error) {
        write_log('Email setup failed: ' . $error->getMessage());
        return null;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The ONE place where an email is sent. Every sender below uses it, so validation, logging and error handling are the same everywhere.
// Returns [true, ''] or [false, 'short reason for the administrator']. Never throws, never prints the SMTP password.
// $label is only for the error log ("password reset"). $mail may be a mailer made earlier by configured_mailer().
// ---------------------------------------------------------------------------------------------------------------
function mail_send($toEmail, $toName, $subject, $html, $text, $label, $mail = null) {
    $toEmail = trim((string)$toEmail);
    if (!filter_var($toEmail, FILTER_VALIDATE_EMAIL)) return [false, 'The recipient email address is not valid.'];
    $mail = $mail ?: configured_mailer();
    if (!$mail) return [false, 'Email is not configured. Check MAIL_HOST, MAIL_FROM, MAIL_USERNAME and MAIL_PASSWORD in .env, and that "composer install" was run.'];
    try {
        $mail->addAddress($toEmail, (string)$toName);
        $mail->isHTML(true);
        $mail->Subject = $subject;
        $mail->Body = $html;
        $mail->AltBody = $text;
        $mail->send();
        return [true, ''];
    } catch (Throwable $error) {
        // Log the reason and who it was for (masked), never the password or the whole message.
        $masked = preg_replace('/^(.).*(@.*)$/', '$1***$2', $toEmail);
        write_log("Email ($label) to $masked failed: " . preg_replace('/\s+/', ' ', $error->getMessage()));
        return [false, mail_friendly_error($error->getMessage())];
    }
}

// Turns PHPMailer's technical message into a hint the administrator can act on.
function mail_friendly_error($message) {
    $m = strtolower($message);
    if (strpos($m, 'authenticate') !== false || strpos($m, 'username and password') !== false) return 'The SMTP server refused the username or password (MAIL_USERNAME / MAIL_PASSWORD). Gmail needs an App Password.';
    if (strpos($m, 'connect') !== false || strpos($m, 'timed out') !== false) return 'Could not connect to the SMTP server. Check MAIL_HOST, MAIL_PORT, MAIL_ENCRYPTION (587 = tls, 465 = ssl) and that the host allows outgoing SMTP.';
    if (strpos($m, 'sender') !== false || strpos($m, 'from address') !== false) return 'The SMTP server refused the sender address. MAIL_FROM usually must be the same mailbox as MAIL_USERNAME.';
    if (strpos($m, 'recipient') !== false) return 'The SMTP server refused the recipient address.';
    return 'The email server did not accept the message. See storage/error.log.';
}

function mail_h($value) { return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }

function processing_date_email_default_template() {
    return [
        'subject' => 'Expected Release Date for Your COLM Request — {{tracking_no}}',
        'body' => "Hello {{student_name}},\n\n"
            . "Your request is now being processed. The Registrar's Office has set the expected release date for your requested document(s):\n\n"
            . "Expected release date: {{expected_release_date}}\n"
            . "Request reference: {{tracking_no}}\n"
            . "Document(s): {{documents}}\n\n"
            . "You can check the latest progress using the button below.\n\n"
            . "{{tracking_url}}\n\n"
            . "Regards,\nCOLM Registrar's Office",
    ];
}

function processing_date_email_template() {
    $saved = fetch_one("SELECT subject, body FROM email_templates WHERE template_key = 'PROCESSING_DATE'");
    return $saved ?: processing_date_email_default_template();
}

function render_processing_date_email_body($body, $values) {
    $parts = preg_split('/({{\s*[a-z_]+\s*}})/', (string)$body, -1, PREG_SPLIT_DELIM_CAPTURE);
    $html = '';
    foreach ($parts as $part) {
        if (preg_match('/^{{\s*([a-z_]+)\s*}}$/', $part, $match)) {
            $key = $match[1];
            if ($key === 'tracking_url') {
                $url = mail_h($values[$key] ?? '');
                $html .= '<a href="' . $url . '" style="display:inline-block;background:#0b4a36;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:6px;">Track My Request</a>';
            } else {
                $html .= mail_h($values[$key] ?? '');
            }
        } else {
            $html .= nl2br(mail_h($part), false);
        }
    }
    return $html;
}

function send_student_account_email($email, $fullName, $username, $password) {
    [$ok] = mail_send($email, $fullName, 'Your COLM student account',
        '<p>Hello ' . mail_h($fullName) . ',</p><p>Your COLM student portal account is ready.</p>'
        . '<p>Student ID / username: <strong>' . mail_h($username) . '</strong><br>Temporary password: <strong>' . mail_h($password) . '</strong></p>'
        . '<p>Sign in to the COLM student portal and change your temporary password when prompted.</p>',
        "Hello {$fullName},\nYour COLM student portal account is ready.\nStudent ID / username: {$username}\nTemporary password: {$password}\n"
        . 'Sign in to the COLM student portal and change your temporary password when prompted.', 'student account');
    return $ok;
}

function send_student_approval_email($email, $fullName, $studentId) {
    [$ok] = mail_send($email, $fullName, 'Your COLM student account is approved',
        '<p>Hello ' . mail_h($fullName) . ',</p><p>Your COLM student portal account has been approved. You can now sign in using your Student ID <strong>' . mail_h($studentId) . '</strong> and the password you created during registration.</p>',
        "Hello {$fullName},\nYour COLM student portal account has been approved. You can now sign in using your Student ID {$studentId} and the password you created during registration.", 'account approval');
    return $ok;
}

function send_request_confirmation_email($email, $fullName, $trackingNo, $items, $total, $trackUrl) {
    $itemLines = [];
    foreach ($items as $item) {
        $itemLines[] = $item['doc']['name'] . ' × ' . $item['quantity'];
    }
    $itemText = implode("\n", $itemLines);
    $itemHtml = implode('<br>', array_map(fn($line) => mail_h($line), $itemLines));
    $subject = "COLM request received ($trackingNo)";
    // The tracking number is plain text (not a link); only the "Track my request" button opens the Track page.
    $link = '<strong style="color:#0b4a36;text-decoration:none;">' . mail_h($trackingNo) . '</strong>';
    $blocks = '<p style="margin:0 0 12px;">Hello ' . mail_h($fullName) . ',</p>'
        . '<p style="margin:0 0 12px;">We received your document request. Here are your details:</p>'
        . mail_details_box(
            mail_kv('Requester', mail_h($fullName))
            . mail_kv('Tracking number', $link)
            . mail_kv('Documents', $itemHtml)
            . mail_kv('Total', 'PHP ' . number_format((float)$total, 2))
        )
        . '<p style="margin:16px 0;"><a href="' . mail_h($trackUrl) . '" style="display:inline-block;background:#0b4a36;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:6px;">Track my request</a></p>'
        . '<p style="margin:0;font-size:14px;color:#6b7785;">Click the Track my request button to see the live status of your request. You pay when you claim your document; bring a valid ID.</p>';
    $html = mail_layout('COLM request received', '#0b4a36', "Your tracking number is $trackingNo", $blocks);
    $text = "Hello {$fullName},\n\nWe received your document request.\n\n"
        . "Requester: {$fullName}\nTracking number: {$trackingNo}\nDocuments:\n{$itemText}\n"
        . 'Total: PHP ' . number_format((float)$total, 2) . "\n\n"
        . "Track your request (live status):\n{$trackUrl}\n\n"
        . 'You pay when you claim your document; bring a valid ID.';
    return mail_send($email, $fullName, $subject, $html, $text, 'request confirmation');
}

function send_password_reset_email($email, $fullName, $resetUrl, $mail = null) {
    [$ok] = mail_send($email, $fullName, 'Reset your COLM portal password',
        '<p>Hello ' . mail_h($fullName) . ',</p><p>We received a request to reset your COLM portal password.</p>'
        . '<p><a href="' . mail_h($resetUrl) . '">Reset your password</a></p>'
        . '<p>This link expires in 30 minutes and can only be used once. If you did not request this, you can ignore this email.</p>',
        "Hello {$fullName},\nWe received a request to reset your COLM portal password.\nUse this link within 30 minutes (one use only):\n{$resetUrl}\nIf you did not request this, you can ignore this email.",
        'password reset', $mail);
    return $ok;
}

// ---------------------------------------------------------------------------------------------------------------
// Responsive HTML shell shared by the status emails. Table layout + inline CSS so Gmail / Outlook / phones all render it.
// $blocks is already-escaped HTML. $preheader is the grey preview text shown next to the subject in the inbox.
// ---------------------------------------------------------------------------------------------------------------
function mail_layout($title, $accent, $preheader, $blocks) {
    $school = mail_h(env('MAIL_FROM_NAME', 'COLM Registrar'));
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<meta name="x-apple-disable-message-reformatting"><title>' . mail_h($title) . '</title>'
        . '<style>@media only screen and (max-width:620px){.wrap{width:100%!important}.pad{padding:20px!important}.kv td{display:block!important;width:100%!important;padding:2px 0!important}}</style>'
        . '</head><body style="margin:0;padding:0;background:#f1f3f6;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">'
        . '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' . mail_h($preheader) . '</div>'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f6;"><tr><td align="center" style="padding:24px 12px;">'
        . '<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e2e6ea;">'
        . '<tr><td style="background:' . $accent . ';padding:18px 28px;color:#ffffff;font-size:13px;letter-spacing:.5px;text-transform:uppercase;font-weight:bold;">' . $school . '</td></tr>'
        . '<tr><td class="pad" style="padding:28px;font-size:15px;line-height:1.6;">' . $blocks . '</td></tr>'
        . '<tr><td style="padding:16px 28px;background:#f8f9fb;border-top:1px solid #e2e6ea;font-size:12px;line-height:1.5;color:#6b7785;">'
        . 'This is an automatic message from the ' . $school . ' document request system. Please do not share your reference number with other people.</td></tr>'
        . '</table></td></tr></table></body></html>';
}

// One "Label: value" row inside the grey details box.
function mail_kv($label, $valueHtml) {
    return '<tr class="kv"><td style="padding:4px 12px 4px 0;color:#6b7785;width:150px;vertical-align:top;font-size:14px;">' . mail_h($label)
        . '</td><td style="padding:4px 0;font-size:14px;font-weight:bold;vertical-align:top;">' . $valueHtml . '</td></tr>';
}

function mail_details_box($rowsHtml) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;border-radius:6px;margin:16px 0;"><tr><td style="padding:14px 16px;">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' . $rowsHtml . '</table></td></tr></table>';
}

// Where and when to claim. Set PICKUP_OFFICE and PICKUP_HOURS in .env (defaults below match the previous wording).
function mail_pickup_office() { return trim((string)env('PICKUP_OFFICE', 'Office of the Registrar, COLM')); }
function mail_pickup_hours() { return trim((string)env('PICKUP_HOURS', 'Monday to Friday, 9:00 A.M. - 4:00 P.M.')); }

// "Your document is ready for pickup". Returns [true, ''] or [false, 'reason'].
function send_ready_for_pickup_email($email, $fullName, $trackingNo, $documents, $expectedRelease, $claimBy, $paymentNote) {
    $docs = $documents ?: ['Your requested document'];
    $office = mail_pickup_office();
    $hours = mail_pickup_hours();

    $rows = mail_kv('Tracking / Reference No.', '<span style="font-size:16px;letter-spacing:.5px;">' . mail_h($trackingNo) . '</span>')
        . mail_kv('Document(s)', implode('<br>', array_map('mail_h', $docs)));
    if ($expectedRelease !== '') $rows .= mail_kv('Expected release', mail_h($expectedRelease));
    if ($claimBy !== '') $rows .= mail_kv('Claim on or before', mail_h($claimBy));

    $reqs = ['Present your <strong>official Payment Receipt</strong> (Official Receipt).',
             'Bring a <strong>valid Student ID or Government-issued ID</strong>.',
             'Show your <strong>Tracking / Reference Code</strong>: <strong>' . mail_h($trackingNo) . '</strong>.'];
    $reqHtml = '<ol style="margin:8px 0 0 0;padding-left:20px;">' . implode('', array_map(fn($r) => '<li style="margin:4px 0;">' . $r . '</li>', $reqs)) . '</ol>';

    $html = '<h1 style="margin:0 0 12px 0;font-size:22px;color:#1b6e3c;">Your document is ready for pickup</h1>'
        . '<p style="margin:0 0 8px 0;">Hello ' . mail_h($fullName) . ',</p>'
        . '<p style="margin:0 0 8px 0;">Good news! Your requested document is now ready for collection at the Registrar\'s Office.</p>'
        . mail_details_box($rows)
        . '<h2 style="margin:20px 0 4px 0;font-size:16px;">What to bring when you claim</h2>' . $reqHtml
        . '<h2 style="margin:20px 0 4px 0;font-size:16px;">Where and when</h2>'
        . '<p style="margin:0;"><strong>' . mail_h($office) . '</strong><br>' . mail_h($hours) . '</p>';
    if ($paymentNote !== '') {
        $html .= '<p style="margin:16px 0 0 0;padding:10px 14px;background:#fff8e6;border-left:4px solid #e0a800;font-size:14px;">' . mail_h($paymentNote) . '</p>';
    }
    $html .= '<p style="margin:20px 0 0 0;font-size:14px;color:#52606d;">If you cannot come yourself, your representative must bring your valid ID, a signed letter of authorization, a copy of your ID, and the requirements above. Unclaimed requests are cancelled after 14 days.</p>';

    $text = "Hello {$fullName},\n\nYour requested document is READY FOR PICKUP.\n\n"
        . "Tracking / Reference No.: {$trackingNo}\nDocument(s): " . implode('; ', $docs) . "\n"
        . ($expectedRelease !== '' ? "Expected release: {$expectedRelease}\n" : '')
        . ($claimBy !== '' ? "Claim on or before: {$claimBy}\n" : '')
        . "\nWHAT TO BRING\n1. Your official Payment Receipt (Official Receipt).\n2. A valid Student ID or Government-issued ID.\n3. Your Tracking / Reference Code: {$trackingNo}\n"
        . "\nWHERE AND WHEN\n{$office}\n{$hours}\n"
        . ($paymentNote !== '' ? "\n{$paymentNote}\n" : '')
        . "\nIf you cannot come yourself, your representative must bring your valid ID, a signed letter of authorization, a copy of your ID, and the requirements above. Unclaimed requests are cancelled after 14 days.";

    return mail_send($email, $fullName, "Your document is ready for pickup ($trackingNo)",
        mail_layout('Your document is ready for pickup', '#1b6e3c', "Reference {$trackingNo}: bring your receipt and a valid ID to claim it.", $html),
        $text, 'ready for pickup');
}

// "Your request was rejected" with the registrar's exact reason and what to do next. Returns [true, ''] or [false, 'reason'].
function send_request_rejected_email($email, $fullName, $trackingNo, $documents, $reason, $paymentNote = '') {
    $docs = $documents ?: ['Your requested document'];
    $office = mail_pickup_office();
    $hours = mail_pickup_hours();
    $siteUrl = app_base_url();
    $replyTo = trim((string)env('MAIL_REPLY_TO', ''));

    $rows = mail_kv('Tracking / Reference No.', mail_h($trackingNo))
        . mail_kv('Document(s)', implode('<br>', array_map('mail_h', $docs)))
        . mail_kv('Status', '<span style="color:#b42318;">Rejected</span>');

    $steps = ['Read the reason above and fix the problem (for example, upload a clear, complete and valid copy of the requirement).',
              'Submit a <strong>new request</strong> using the Request form on our website: <a href="' . mail_h($siteUrl) . '" style="color:#1a56a0;">' . mail_h($siteUrl) . '</a>. A rejected request cannot be reopened.',
              'Use the same Student ID and email address as before so your records match.',
              'Need help? Visit the ' . mail_h($office) . ' (' . mail_h($hours) . ')' . ($replyTo !== '' ? ' or reply to this email (' . mail_h($replyTo) . ')' : '') . '. Mention your reference number.'];
    $stepHtml = '<ol style="margin:8px 0 0 0;padding-left:20px;">' . implode('', array_map(fn($s) => '<li style="margin:4px 0;">' . $s . '</li>', $steps)) . '</ol>';

    $html = '<h1 style="margin:0 0 12px 0;font-size:22px;color:#b42318;">Your document request was rejected</h1>'
        . '<p style="margin:0 0 8px 0;">Hello ' . mail_h($fullName) . ',</p>'
        . '<p style="margin:0 0 8px 0;">We are sorry, but we could not approve your document request.</p>'
        . mail_details_box($rows)
        . '<h2 style="margin:20px 0 4px 0;font-size:16px;">Reason for rejection</h2>'
        . '<p style="margin:0;padding:12px 14px;background:#fdecea;border-left:4px solid #b42318;font-size:14px;white-space:pre-line;">' . mail_h($reason) . '</p>'
        . '<h2 style="margin:20px 0 4px 0;font-size:16px;">How to re-apply</h2>' . $stepHtml;
    if ($paymentNote !== '') {
        $html .= '<p style="margin:16px 0 0 0;padding:10px 14px;background:#fff8e6;border-left:4px solid #e0a800;font-size:14px;">' . mail_h($paymentNote) . '</p>';
    }

    $text = "Hello {$fullName},\n\nWe are sorry, but we could not approve your document request.\n\n"
        . "Tracking / Reference No.: {$trackingNo}\nDocument(s): " . implode('; ', $docs) . "\nStatus: Rejected\n\n"
        . "REASON FOR REJECTION\n{$reason}\n\nHOW TO RE-APPLY\n"
        . "1. Fix the problem described above (for example, upload a clear, complete and valid copy of the requirement).\n"
        . "2. Submit a new request using the Request form on our website: {$siteUrl} (a rejected request cannot be reopened).\n"
        . "3. Use the same Student ID and email address as before.\n"
        . "4. Need help? Visit the {$office} ({$hours})" . ($replyTo !== '' ? " or reply to this email ({$replyTo})" : '') . ". Mention your reference number.\n"
        . ($paymentNote !== '' ? "\n{$paymentNote}\n" : '');

    return mail_send($email, $fullName, "Your document request was rejected ($trackingNo)",
        mail_layout('Your document request was rejected', '#b42318', "Reference {$trackingNo}: see the reason and how to re-apply.", $html),
        $text, 'request rejected');
}