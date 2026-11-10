<?php
// Semester master lists and their validation records.
//
// A "master list import" is one CSV of the students enrolled in ONE semester of ONE academic year. Every row becomes a validation record:
//   VALIDATED      the student has a portal account and name, course and year level agree with the list
//   MISMATCH       the account exists but something differs (the note says what)
//   (NOT_REGISTERED is no longer produced: students request as guests with their Gmail, so a portal account is not needed.)
//   INVALID        the row itself is unusable (for example the ID has the wrong format)
// Imports older than the configured academic year are archived after staff confirmation. Records are never copied, changed or deleted:
// "archived" is the status of the import they belong to, so history can not be overwritten by a later import.
require_once __DIR__ . '/students.php';
require_once __DIR__ . '/names.php';
require_once __DIR__ . '/audit.php';

const SEMESTER_LABELS = [1 => '1st Semester', 2 => '2nd Semester', 3 => 'Summer'];

// 2025-2026 + 2nd Semester => 20252. Bigger = later. Returns null when the academic year or the semester is not valid.
function master_period_key($academicYear, $semester) {
    $semester = (int)$semester;
    if (!isset(SEMESTER_LABELS[$semester]) || !master_valid_academic_year($academicYear)) return null;
    return (int)substr($academicYear, 0, 4) * 10 + $semester;
}

// Any academic year from 1950 up to 2099 is accepted (2027-2028, 2028-2029, 2029-2030 ...). The two years must follow each other.
function master_valid_academic_year($value) {
    if (!preg_match('/^(\d{4})-(\d{4})$/', (string)$value, $m)) return false;
    $start = (int)$m[1]; $end = (int)$m[2];
    return $start >= 1950 && $start <= 2099 && $end === $start + 1;
}

function master_period_label($academicYear, $semester) {
    return (SEMESTER_LABELS[(int)$semester] ?? 'Semester ' . (int)$semester) . ', A.Y. ' . $academicYear;
}

function current_academic_year() {
    $setting = fetch_one('SELECT academic_year FROM academic_year_settings WHERE id = 1');
    if ($setting && master_valid_academic_year($setting['academic_year'])) return $setting['academic_year'];
    $start = (int)date('Y');
    return $start . '-' . ($start + 1);
}

function active_student_academic_year($studentNo) {
    $studentNo = trim((string)$studentNo);
    if ($studentNo === '') return '';
    $record = fetch_one("SELECT m.academic_year
                         FROM validation_records v
                         JOIN master_list_imports m ON m.id = v.import_id
                         WHERE v.student_no = ? AND m.status = 'ACTIVE'
                         ORDER BY m.period_key DESC, v.id DESC
                         LIMIT 1", [$studentNo]);
    return trim((string)($record['academic_year'] ?? ''));
}

function master_imports_to_archive(array $imports, $currentAcademicYear) {
    $currentStart = (int)substr((string)$currentAcademicYear, 0, 4);
    return array_values(array_filter($imports, fn($import) =>
        $import['status'] === 'ACTIVE' && (int)substr((string)$import['academic_year'], 0, 4) < $currentStart));
}

// The email of each student is saved with the record. Older databases get the column automatically (once per request, one cheap check).
function ensure_master_email_column() {
    static $done = false;
    if ($done) return;
    $pdo = db();
    $has = (int)$pdo->query("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'validation_records' AND COLUMN_NAME = 'email'")->fetchColumn();
    if (!$has) $pdo->exec('ALTER TABLE validation_records ADD COLUMN email VARCHAR(190) NULL AFTER student_name');
    $done = true;
}

// Compares one CSV row with the portal account. Returns [status, note].
function master_row_status($data, $structure = null) {
    $studentNo = trim((string)($data['student_id'] ?? ''));
    $name = trim((string)($data['full_name'] ?? ''));
    $structure = $structure ?? school_structure();
    // Every row is checked on all columns; all the problems of the row are reported together.
    $problems = [];
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9-]{3,29}$/', $studentNo)) $problems[] = 'the student ID has the wrong format';
    if ($name === '') $problems[] = 'the name is empty';
    // Course: only a course that exists in the school list.
    $courseIn = trim((string)($data['course'] ?? ''));
    if ($courseIn === '') $problems[] = 'the course is empty';
    elseif (level_of_course($courseIn, $structure) === null) $problems[] = 'the course "' . mb_substr($courseIn, 0, 40) . '" is not in the school course list';
    // Year level: 1 to 4 only.
    $yearIn = trim((string)($data['year'] ?? ''));
    $yearNo = $yearIn === '' ? null : parse_year_level($yearIn);
    if ($yearIn === '') $problems[] = 'the year level is empty';
    elseif ($yearNo === null || $yearNo < 1 || $yearNo > 4) $problems[] = 'the year level must be 1 to 4';
    // Gmail: must be a valid @gmail.com address.
    $email = trim((string)($data['email'] ?? ''));
    if ($email === '') $problems[] = 'the Gmail address is empty';
    elseif (!preg_match('/^[A-Za-z0-9._%+-]+@gmail\.com$/i', $email)) $problems[] = 'the Gmail address must end with @gmail.com';
    if ($problems) return ['INVALID', mb_substr(ucfirst(implode('; ', $problems)) . '.', 0, 250)];

    $account = fetch_one("SELECT u.full_name, s.course, s.year_level, s.school_level FROM users u
                          LEFT JOIN students s ON s.user_id = u.id
                          WHERE u.role = 'student' AND (u.student_no = ? OR u.username = ?) LIMIT 1", [$studentNo, $studentNo]);
    if (!$account) return ['VALIDATED', null];            // no portal account needed: the student is checked by the list and the Gmail code

    $problems = [];
    // names_match() returns ['match' => bool, 'score' => n]; both directions must agree (it accepts any word order and one wrong letter in a long word).
    if (!names_match($account['full_name'], $name)['match'] || !names_match($name, $account['full_name'])['match']) $problems[] = 'name';
    $course = trim((string)($data['course'] ?? ''));
    if ($course !== '' && mb_strtolower($course) !== mb_strtolower((string)$account['course'])) $problems[] = 'course';
    $year = trim((string)($data['year'] ?? ''));
    if ($year !== '') {
        $parsed = parse_year_level($year);
        if ($parsed === null || (int)$parsed !== (int)$account['year_level']) $problems[] = 'year level';
    }
    if ($problems) return ['MISMATCH', 'The list and the portal account differ: ' . implode(', ', $problems) . '.'];
    return ['VALIDATED', null];
}

// Reads the CSV and checks every row. Depends only on what is IN the file (columns, course, year level, Gmail), not on any academic year or semester.
// Throws RuntimeException when the file itself can not be used. Returns the records to save and the summary for the browser.
function check_master_csv($path) {
    $rows = read_students_csv($path, ['student_id', 'full_name', 'course', 'year', 'email']);       // all five columns are required: a file with other columns is refused
    $hash = hash_file('sha256', $path);

    $structure = school_structure();
    $invalid = [];
    $records = []; $skipped = []; $seen = []; $counts = ['VALIDATED' => 0, 'MISMATCH' => 0, 'NOT_REGISTERED' => 0, 'INVALID' => 0];
    foreach ($rows as $row) {
        $data = $row['data'];
        $studentNo = trim((string)($data['student_id'] ?? ''));
        if ($studentNo === '') { $skipped[] = ['line' => $row['line'], 'reason' => 'No student ID.']; continue; }
        $dupKey = mb_strtolower($studentNo);
        if (isset($seen[$dupKey])) { $skipped[] = ['line' => $row['line'], 'reason' => "Student ID $studentNo appears twice (first on line {$seen[$dupKey]}). The first one is used."]; continue; }
        $seen[$dupKey] = $row['line'];
        [$status, $note] = master_row_status($data, $structure);
        $counts[$status]++;
        if ($status === 'INVALID' && count($invalid) < 100) $invalid[] = ['line' => $row['line'], 'student_id' => mb_substr($studentNo, 0, 30), 'reason' => $note];
        $records[] = [
            'student_no' => mb_substr($studentNo, 0, 30), 'name' => mb_substr(trim((string)($data['full_name'] ?? '')) ?: '(no name)', 0, 150),
            'course' => mb_substr(trim((string)($data['course'] ?? '')), 0, 100) ?: null,
            'year' => mb_substr(trim((string)($data['year'] ?? '')), 0, 30) ?: null,
            'email' => mb_substr(trim((string)($data['email'] ?? '')), 0, 190) ?: null,
            'status' => $status, 'note' => $note,
        ];
    }
    if (!$records) throw new RuntimeException('The file has no usable student rows.');
    return ['hash' => $hash, 'records' => $records, 'counts' => $counts, 'skipped' => $skipped, 'invalid' => $invalid];
}

// Content check only (used by the automatic check in the browser): no academic year, no semester, nothing is saved.
function check_master_list_file($path) {
    $c = check_master_csv($path);
    return ['rows' => count($c['records']), 'counts' => $c['counts'], 'skipped' => $c['skipped'], 'invalid' => $c['invalid']];
}

// Checks the file, then (unless $dryRun) saves the import and archives the older active imports in ONE database transaction.
// Throws RuntimeException with a clear message when the import must not happen. Returns the plan / result for the browser.
function master_archive_ids(array $imports, $academicYear) {
    $ids = array_map(fn($import) => (int)$import['id'], master_imports_to_archive($imports, $academicYear));
    sort($ids, SORT_NUMERIC);
    return $ids;
}

function import_master_list($path, $academicYear, $semester, $user, $dryRun, $confirmedArchiveIds = null, $confirmedCurrentAcademicYear = null, $confirmedNewListWillArchive = null) {
    $academicYear = trim((string)$academicYear);
    $key = master_period_key($academicYear, $semester);
    if ($key === null) throw new RuntimeException('Choose a valid academic year (for example 2025-2026) and semester.');
    $semester = (int)$semester;

    $checked = check_master_csv($path);
    $hash = $checked['hash']; $records = $checked['records']; $counts = $checked['counts']; $skipped = $checked['skipped']; $invalid = $checked['invalid'];
    if ($counts['INVALID'] > 0) throw new RuntimeException($counts['INVALID'] . ' row(s) in the file have errors. Fix the file first (course, year level 1-4, @gmail.com).');

    $pdo = db();
    if (!$dryRun) ensure_master_email_column();      // ALTER TABLE ends a transaction in MySQL, so it is done before the transaction starts
    try {
        $pdo->beginTransaction();
        if (!$dryRun) {
            $calendarStart = (int)date('Y');
            $calendarAcademicYear = $calendarStart . '-' . ($calendarStart + 1);
            query('INSERT IGNORE INTO academic_year_settings (id, academic_year, updated_by) VALUES (1, ?, ?)',
                [$calendarAcademicYear, $user['id']]);
            $setting = fetch_one('SELECT academic_year FROM academic_year_settings WHERE id = 1 FOR UPDATE');
            $currentAcademicYear = master_valid_academic_year($setting['academic_year'] ?? '')
                ? $setting['academic_year'] : $calendarAcademicYear;
        } else {
            $currentAcademicYear = current_academic_year();
        }
        // The table is small; locking every row makes two people importing at the same time wait for each other.
        $imports = fetch_all('SELECT id, academic_year, semester, period_key, file_sha256, status FROM master_list_imports ORDER BY period_key FOR UPDATE');

        // Same semester already imported and still ACTIVE: the file is ADDED to that list (students already in it are skipped, only new ones are saved).
        $sameActive = null;
        foreach ($imports as $existing) {
            if ((int)$existing['period_key'] === $key) {
                if ($existing['status'] !== 'ACTIVE') {
                    throw new RuntimeException(master_period_label($academicYear, $semester) . ' was already imported and is archived. Archived lists are never changed.');
                }
                $sameActive = $existing;
            }
            // The same file may be used again for ANOTHER semester or academic year (for example 2027-2028 with the same students).
        }
        $latest = $imports ? end($imports) : null;
        if ($latest && (int)$latest['period_key'] > $key) {
            throw new RuntimeException('A newer list already exists (' . master_period_label($latest['academic_year'], $latest['semester']) . '). Importing an older semester is not supported, so no wrong records are archived.');
        }
        // Keep every semester of the configured current academic year active; archive only after staff confirms the preview.
        $toArchive = master_imports_to_archive($imports, $currentAcademicYear);
        $archiveIds = master_archive_ids($imports, $currentAcademicYear);
        if (!$dryRun && $archiveIds && $archiveIds !== $confirmedArchiveIds) {
            throw new RuntimeException('The archive plan changed while you were reviewing it. Please review the import again.');
        }
        $newListWillArchive = !$sameActive
            && (int)substr($academicYear, 0, 4) < (int)substr($currentAcademicYear, 0, 4);
        if (!$dryRun && ($confirmedCurrentAcademicYear !== $currentAcademicYear
            || $confirmedNewListWillArchive !== $newListWillArchive)) {
            throw new RuntimeException('The current academic year changed while you were reviewing the import. Please review it again.');
        }
        $alreadyListed = 0;
        if ($sameActive) {
            $have = [];
            foreach (fetch_all('SELECT student_no FROM validation_records WHERE import_id = ?', [(int)$sameActive['id']]) as $h) $have[mb_strtolower((string)$h['student_no'])] = true;
            $newRecords = [];
            $counts = ['VALIDATED' => 0, 'MISMATCH' => 0, 'NOT_REGISTERED' => 0, 'INVALID' => 0];
            foreach ($records as $r) {
                if (isset($have[mb_strtolower($r['student_no'])])) { $alreadyListed++; continue; }
                $newRecords[] = $r; $counts[$r['status']]++;
            }
            $records = $newRecords;
        }
        $plan = [
            'merge' => (bool)$sameActive, 'already_listed' => $alreadyListed,
            'period' => master_period_label($academicYear, $semester), 'rows' => count($records), 'counts' => $counts, 'skipped' => $skipped, 'invalid' => $invalid,
            'will_archive' => array_map(fn($i) => ['id' => (int)$i['id'], 'label' => master_period_label($i['academic_year'], $i['semester'])], $toArchive),
            'new_list_will_archive' => $newListWillArchive,
            'current_academic_year' => $currentAcademicYear,
        ];
        if ($dryRun) { $pdo->commit(); return $plan + ['saved' => false]; }

        $now = date('Y-m-d H:i:s');
        if ($sameActive) {
            $importId = (int)$sameActive['id'];
            if ($records) query('UPDATE master_list_imports SET row_count = row_count + ? WHERE id = ?', [count($records), $importId]);
        } else {
            query('INSERT INTO master_list_imports (academic_year, semester, period_key, file_sha256, row_count, status, imported_by, imported_at) VALUES (?, ?, ?, ?, ?, \'ACTIVE\', ?, ?)',
                [$academicYear, $semester, $key, hash('sha256', $hash . '|' . $key), count($records), $user['id'], $now]);      // file hash + period: the same file can be imported for another period
            $importId = (int)$pdo->lastInsertId();
        }
        foreach (array_chunk($records, 200) as $chunk) {
            $marks = implode(',', array_fill(0, count($chunk), '(?, ?, ?, ?, ?, ?, ?, ?, ?)'));
            $params = [];
            foreach ($chunk as $r) array_push($params, $importId, $r['student_no'], $r['name'], $r['email'], $r['course'], $r['year'], $r['status'], $r['note'], $now);
            $sql = 'INSERT INTO validation_records (import_id, student_no, student_name, email, course, year_level, validation_status, validation_note, validated_at) VALUES ' . $marks;
            query($sql, $params);
        }
        if (!$sameActive || $records) {
            audit_log('masterlist_import', 'master_list', $importId, null, $user['id'], null, master_period_label($academicYear, $semester),
                count($records) . ' records' . ($sameActive ? ' added to the existing list (' . $alreadyListed . ' already listed, skipped).' : '.'));
        }

        if ($newListWillArchive) {
            $note = 'Archived on import because the configured current academic year is ' . $currentAcademicYear . '.';
            $changed = query("UPDATE master_list_imports SET status = 'ARCHIVED', archived_at = ?, archived_by = ?, archive_note = ? WHERE id = ? AND status = 'ACTIVE'",
                [$now, $user['id'], $note, $importId])->rowCount();
            if ($changed) audit_log('masterlist_archive', 'master_list', $importId, null, $user['id'], 'ACTIVE', 'ARCHIVED', $note);
        }
        foreach ($toArchive as $old) {
            $changed = query("UPDATE master_list_imports SET status = 'ARCHIVED', archived_at = ?, archived_by = ?, archive_note = ? WHERE id = ? AND status = 'ACTIVE'",
                [$now, $user['id'], 'Archived when ' . master_period_label($academicYear, $semester) . ' was imported.', $old['id']])->rowCount();
            if ($changed) audit_log('masterlist_archive', 'master_list', (int)$old['id'], null, $user['id'], 'ACTIVE', 'ARCHIVED', 'Archived by the import of ' . master_period_label($academicYear, $semester) . '.');
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;      // nothing was saved: not the import, not the archiving
    }
    return $plan + ['saved' => true, 'import_id' => $importId];
}

// Search the records (active and archived). Filters: academic_year, semester, student_no, name, status, scope (active|archived|all), archived_from, archived_to.
function search_validation_records($filters, $page, $perPage = 25) {
    ensure_master_email_column();
    $where = []; $params = [];
    $scope = $filters['scope'] ?? 'all';
    if ($scope === 'active') $where[] = "m.status = 'ACTIVE'";
    elseif ($scope === 'archived') $where[] = "m.status = 'ARCHIVED'";
    if (($filters['academic_year'] ?? '') !== '') { $where[] = 'm.academic_year = ?'; $params[] = $filters['academic_year']; }
    if ((int)($filters['semester'] ?? 0) > 0) { $where[] = 'm.semester = ?'; $params[] = (int)$filters['semester']; }
    if (($filters['student_no'] ?? '') !== '') { $where[] = 'v.student_no LIKE ?'; $params[] = '%' . $filters['student_no'] . '%'; }
    if (($filters['name'] ?? '') !== '') { $where[] = 'v.student_name LIKE ?'; $params[] = '%' . $filters['name'] . '%'; }
    if (in_array($filters['status'] ?? '', ['VALIDATED', 'MISMATCH', 'NOT_REGISTERED', 'INVALID'], true)) { $where[] = 'v.validation_status = ?'; $params[] = $filters['status']; }
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $filters['archived_from'] ?? '')) { $where[] = 'm.archived_at >= ?'; $params[] = $filters['archived_from'] . ' 00:00:00'; }
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $filters['archived_to'] ?? '')) { $where[] = 'm.archived_at <= ?'; $params[] = $filters['archived_to'] . ' 23:59:59'; }
    $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $from = 'FROM validation_records v JOIN master_list_imports m ON m.id = v.import_id';
    $total = (int)fetch_one("SELECT COUNT(*) AS c $from $whereSql", $params)['c'];
    $page = max(1, (int)$page);
    $offset = ($page - 1) * $perPage;
    $rows = fetch_all("SELECT v.id, v.student_no, v.student_name, v.email, v.course, v.year_level, v.validation_status, v.validation_note, v.validated_at,
                              m.academic_year, m.semester, m.status AS list_status, m.archived_at
                       $from $whereSql ORDER BY m.period_key DESC, v.student_name ASC, v.id ASC LIMIT $perPage OFFSET $offset", $params);
    foreach ($rows as &$row) $row['semester_label'] = SEMESTER_LABELS[(int)$row['semester']] ?? '';
    return ['records' => $rows, 'total' => $total, 'page' => $page, 'per_page' => $perPage];
}

// ---- Per-student view of the validation records (Admin > Students, and the student's own My Profile) ----

// Every validation record of ONE student, newest semester first. Active and archived lists are both included; nothing is changed.
function student_validation_history($studentNo) {
    $studentNo = trim((string)$studentNo);
    if ($studentNo === '') return [];
    $rows = fetch_all('SELECT v.student_no, v.student_name, v.course, v.year_level, v.validation_status, v.validation_note, v.validated_at,
                              m.academic_year, m.semester, m.status AS list_status, m.archived_at
                       FROM validation_records v JOIN master_list_imports m ON m.id = v.import_id
                       WHERE v.student_no = ? ORDER BY m.period_key DESC, v.id DESC', [$studentNo]);
    foreach ($rows as &$row) {
        $row['semester_label'] = SEMESTER_LABELS[(int)$row['semester']] ?? '';
        $row['period_label'] = master_period_label($row['academic_year'], $row['semester']);
    }
    return $rows;
}

// The newest validation record of each given student number (one query for the whole page of the Students list).
// Returns [lowercase student_no => record]. Students that are on no master list yet are simply missing.
function latest_validation_for_students(array $studentNos) {
    $studentNos = array_values(array_unique(array_filter(array_map(fn($n) => trim((string)$n), $studentNos), fn($n) => $n !== '')));
    if (!$studentNos) return [];
    $marks = implode(',', array_fill(0, count($studentNos), '?'));
    $rows = fetch_all("SELECT v.student_no, v.validation_status, v.validation_note, m.academic_year, m.semester, m.status AS list_status
                       FROM validation_records v JOIN master_list_imports m ON m.id = v.import_id
                       WHERE v.student_no IN ($marks) ORDER BY m.period_key DESC, v.id DESC", $studentNos);
    $latest = [];
    foreach ($rows as $row) {
        $key = mb_strtolower($row['student_no']);
        if (isset($latest[$key])) continue;                    // the first row of a student is the newest semester
        $row['period_label'] = master_period_label($row['academic_year'], $row['semester']);
        $latest[$key] = $row;
    }
    return $latest;
}