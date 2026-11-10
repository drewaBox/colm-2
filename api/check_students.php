<?php
// POST {first_name, last_name [, student_id]}  ->  {ok:true, first_name_found:bool, last_name_found:bool, name_found:bool, found:bool}
// Used by the request form to show "not in the records" while the person types.
//   name_found: a student with this exact name is on the school record.
//   found:      the name AND the Student ID belong to the same student (false when no ID was sent).
// Only match flags are returned (no ID, email or course), and checks are rate limited.
require_once __DIR__ . '/../backend/auth.php';
require_once __DIR__ . '/../backend/students.php';
require_once __DIR__ . '/../backend/ratelimit.php';
register_error_handlers();
require_method('POST');

if (!rate_limit_allow('check-student-ip:' . request_ip(), 40, 600)) fail('Too many checks. Please wait a few minutes and try again.', 429);

$in = read_json_body();
// Autofill: {student_id, lookup:true} -> {ok:true, profile:{first_name,last_name,course,year_level}|null}
if (!empty($in['lookup'])) {
    $lookupId = mb_substr(preg_replace('/[^0-9-]/', '', (string)($in['student_id'] ?? '')), 0, 30);
    json_response(['ok' => true, 'profile' => $lookupId === '' ? null : lookup_registered_student_by_id($lookupId)]);
}
$first = clean_text($in['first_name'] ?? '', 50);
$last = clean_text($in['last_name'] ?? '', 50);
$studentId = mb_substr(preg_replace('/[^0-9-]/', '', (string)($in['student_id'] ?? '')), 0, 30);
$course = clean_text($in['course'] ?? '', 80);
$firstNameFound = $first !== '' && registered_name_component_exists($first);
$lastNameFound = $last !== '' && registered_name_component_exists($last);
$nameFound = $first !== '' && $last !== '' && registered_name_exists($first, $last);
$student = $nameFound && $studentId !== '' ? find_registered_student($first, $last, $studentId) : null;
$found = $student !== null;
$courseMatches = null;
if ($student && $course !== '') $courseMatches = mb_strtolower(trim((string)$student['course'])) === mb_strtolower($course);
json_response(['ok' => true, 'first_name_found' => $firstNameFound, 'last_name_found' => $lastNameFound, 'name_found' => $nameFound, 'found' => $found, 'course_matches' => $courseMatches]);