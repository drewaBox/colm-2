<?php
// Public request status lookup by tracking number.
require_once __DIR__ . '/../backend/auth.php';
require_once __DIR__ . '/../backend/workflow.php';
require_once __DIR__ . '/../backend/ratelimit.php';
register_error_handlers();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'POST') {
    $input = read_json_body();
} else {
    require_method('GET');
    $input = $_GET;
}

// Guessing protection: 15 lookups per 10 minutes per visitor, and 8 per 10 minutes for one reference number.
// The Track page refreshes the status by itself (live=1). That is only allowed for a number this visitor already looked up
// successfully in the same session, so it cannot be used to guess numbers.
start_session();
$trackingNumber = strtoupper(clean_text($input['ref'] ?? '', 32));
$live = ($input['live'] ?? '') === '1' && !empty($_SESSION['track_seen'][$trackingNumber]);
if ($live) {
    if (!rate_limit_allow('track-live:' . request_ip(), 300, 600)) fail('Too many tries. Please wait a few minutes and try again.', 429);
    if (!preg_match('/^COLM-\d{8}-\d{5}$/', $trackingNumber)) fail('Tracking number not found.', 404);
} else {
    if (!rate_limit_allow('track-ip:' . request_ip(), 15, 600)) fail('Too many tries. Please wait a few minutes and try again.', 429);
    if (!preg_match('/^COLM-\d{8}-\d{5}$/', $trackingNumber)) fail('Tracking number not found.', 404);
    if (!rate_limit_allow('track-ref:' . $trackingNumber, 8, 600)) fail('Too many tries. Please wait a few minutes and try again.', 429);
}
$email = strtolower(clean_text($input['email'] ?? '', 120));
$request = fetch_one("SELECT r.id, r.tracking_no, r.status, r.expected_release_date, r.completed_at, r.created_at,
                             u.full_name, u.email,
                             r.registrar_remarks,
                             (SELECT h.created_at FROM request_history h
                              WHERE h.request_id = r.id AND h.new_status = 'READY'
                              ORDER BY h.id DESC LIMIT 1) AS released_at,
                             (SELECT h.created_at FROM request_history h
                              WHERE h.request_id = r.id
                              ORDER BY h.id DESC LIMIT 1) AS last_updated_at,
                             (SELECT h.created_at FROM request_history h
                              WHERE h.request_id = r.id AND h.new_status IN ('AI_VERIFYING', 'FOR_REVIEW', 'NEEDS_CORRECTION')
                              ORDER BY h.id DESC LIMIT 1) AS verification_at,
                             (SELECT h.created_at FROM request_history h
                              WHERE h.request_id = r.id AND h.new_status = 'PROCESSING'
                              ORDER BY h.id DESC LIMIT 1) AS processing_at
                      FROM requests r JOIN users u ON u.id = r.student_id
                      WHERE r.tracking_no = ?", [$trackingNumber]);
if (!$request) fail('Tracking number not found.', 404);
if (!$live) {                                    // remember it for this visitor so the automatic refresh may ask again
    $_SESSION['track_seen'][$trackingNumber] = time();
    if (count($_SESSION['track_seen']) > 5) $_SESSION['track_seen'] = array_slice($_SESSION['track_seen'], -5, null, true);
}

$statusDetails = [
    'SUBMITTED' => ['step' => 'submitted', 'description' => 'Your request was received by the Registrar.'],
    'AI_VERIFYING' => ['step' => 'verification', 'description' => 'Your documents are being checked.'],
    'FOR_REVIEW' => ['step' => 'verification', 'description' => 'Your request is waiting for Registrar review.'],
    'NEEDS_CORRECTION' => ['step' => 'verification', 'description' => 'Your request needs corrections before it can continue.'],
    'PROCESSING' => ['step' => 'processing', 'description' => 'Your request is being processed and prepared.'],
    'READY' => ['step' => 'ready', 'description' => 'Your document is ready for release.'],
    'COMPLETED' => ['step' => 'ready', 'description' => 'Your document has been released.'],
    'REJECTED' => ['step' => 'verification', 'description' => 'Your request was rejected. The reason was sent to your email address. Please check your inbox (and spam folder) or contact the Registrar for assistance.'],
    'CANCELLED' => ['step' => 'verification', 'description' => 'Your request was cancelled because it was not paid or claimed in time. Please submit a new request.'],
];
$details = $statusDetails[$request['status']] ?? ['step' => 'submitted', 'description' => 'Your request is being processed.'];
$emailMatched = $email !== '' && hash_equals(strtolower((string)$request['email']), $email);
if ($request['status'] === 'REJECTED' && $emailMatched && !empty(trim((string)($request['registrar_remarks'] ?? '')))) {
    $details['description'] = trim((string)$request['registrar_remarks']);
}
$items = fetch_all("SELECT d.name FROM request_items i
                    JOIN documents d ON d.id = i.document_id
                    WHERE i.request_id = ? ORDER BY i.id", [$request['id']]);
$documentNames = array_values(array_unique(array_column($items, 'name')));
$asIsoDate = static function ($value) {
    return $value ? date(DATE_ATOM, strtotime($value)) : null;
};
$dates = [
    'submitted' => $asIsoDate($request['created_at']),
    'verification' => $asIsoDate($request['verification_at']),
    'processing' => $asIsoDate($request['processing_at']),
    'ready' => $asIsoDate($request['released_at'] ?: $request['completed_at']),
];

json_response(['ok' => true, 'request' => [
    'requestNo' => $request['tracking_no'],
    'requesterName' => $request['full_name'],
    'requestStatus' => $request['status'],
    'status' => $details['step'],
    'statusLabel' => GUEST_STATUS_LABELS[$request['status']] ?? $request['status'],
    'description' => $details['description'],
    'documentName' => implode(', ', $documentNames),
    'reason' => $emailMatched ? ($request['registrar_remarks'] ?: '') : '',
    'completionDate' => $request['expected_release_date'] ? date('F j, Y', strtotime($request['expected_release_date'])) : '',      // set by the Registrar; empty until then
    'updatedAt' => $asIsoDate($request['last_updated_at'] ?: $request['created_at']),
    'dates' => $dates,
]]);