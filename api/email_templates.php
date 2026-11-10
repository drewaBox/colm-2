<?php
require_once __DIR__ . '/../backend/auth.php';
require_once __DIR__ . '/../backend/audit.php';
require_once __DIR__ . '/../backend/mailer.php';
register_error_handlers();

$admin = require_login(['admin']);
$action = $_GET['action'] ?? 'get';

if ($action === 'get') {
    require_method('GET');
    json_response([
        'ok' => true,
        'template' => processing_date_email_template(),
        'defaults' => processing_date_email_default_template(),
        'placeholders' => ['{{student_name}}', '{{tracking_no}}', '{{documents}}', '{{expected_release_date}}', '{{tracking_url}}'],
    ]);
}

require_method('POST');
require_csrf();
$input = read_json_body();

if ($action === 'save') {
    $subject = trim((string)($input['subject'] ?? ''));
    $body = trim((string)($input['body'] ?? ''));
    if ($subject === '' || mb_strlen($subject) > 255) fail('The email subject is required and must be 255 characters or fewer.', 422);
    if ($body === '' || mb_strlen($body) > 6000) fail('The email message is required and must be 6,000 characters or fewer.', 422);

    $allowed = ['student_name', 'tracking_no', 'documents', 'expected_release_date', 'tracking_url'];
    preg_match_all('/{{\s*([a-z_]+)\s*}}/', $subject . "\n" . $body, $matches);
    $unknown = array_values(array_diff(array_unique($matches[1]), $allowed));
    if ($unknown) fail('Unsupported placeholder: {{' . $unknown[0] . '}}.', 422);

    $previous = processing_date_email_template();
    query("INSERT INTO email_templates (template_key, subject, body, updated_by)
           VALUES ('PROCESSING_DATE', ?, ?, ?)
           ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body), updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP",
        [$subject, $body, $admin['id']]);
    audit_log('processing_email_template_saved', 'email_template', null, null, $admin['id'],
        $previous['subject'], $subject, 'Updated the processing release-date email template.');
    json_response(['ok' => true, 'message' => 'Processing email template saved.']);
}

if ($action === 'reset') {
    require_method('POST');
    $previous = processing_date_email_template();
    query("DELETE FROM email_templates WHERE template_key = 'PROCESSING_DATE'");
    $defaults = processing_date_email_default_template();
    audit_log('processing_email_template_reset', 'email_template', null, null, $admin['id'],
        $previous['subject'], $defaults['subject'], 'Restored the default processing release-date email template.');
    json_response(['ok' => true, 'message' => 'Default processing email template restored.']);
}

fail('Unknown action.', 404);
