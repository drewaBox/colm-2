<?php
// Semester master lists, validation records and the archive (admin and registrar; archived records are read-only).
//
//   POST ?action=check      CSV file "csv" only: checks the content of the file (nothing to do with the academic year), saves nothing.
//   POST ?action=import     CSV file "csv" + academic_year + semester (1,2,3). dry_run=1 only shows what would happen.
//                           the preview returns older active lists; actual import requires their confirmed IDs.
//   GET  ?action=imports    every imported list (active and archived)
//   GET  ?action=records    search: academic_year, semester, student_no, name, status, scope (active|archived|all), archived_from, archived_to, page
//   GET  ?action=periods    the year options and configured current academic year
//   POST ?action=set_current_year  academic_year + preview=1 to preview; confirmed_archive_ids to save (admin only)
//   GET  ?action=student_history&student_no=...   one student's records of every semester (admin and registrar)
//   GET  ?action=my_history                       the logged-in student's own records of every semester (students only, read-only)
require_once __DIR__ . '/../backend/auth.php';
require_once __DIR__ . '/../backend/masterlist.php';
register_error_handlers();

$action = $_GET['action'] ?? 'imports';

// A student may only read the history of their OWN student ID. Everything else here is for the staff.
if ($action === 'my_history') {
    require_method('GET');
    $me = require_login(['student']);
    $row = fetch_one('SELECT student_no, username FROM users WHERE id = ?', [(int)$me['id']]);
    json_response(['ok' => true, 'history' => student_validation_history(($row['student_no'] ?? '') ?: ($row['username'] ?? ''))]);
}
$user = require_login(STAFF_ROLES);

switch ($action) {
    case 'imports':
        require_method('GET');
        $rows = fetch_all('SELECT m.id, m.academic_year, m.semester, m.status, m.row_count, m.imported_at, m.archived_at, m.archive_note, u.full_name AS imported_by
                           FROM master_list_imports m LEFT JOIN users u ON u.id = m.imported_by ORDER BY m.period_key DESC');
        foreach ($rows as &$row) { $row['id'] = (int)$row['id']; $row['semester_label'] = SEMESTER_LABELS[(int)$row['semester']] ?? ''; }
        json_response(['ok' => true, 'imports' => $rows]);

    case 'current_enrollments':
        require_method('GET');
        $academicYear = clean_text($_GET['academic_year'] ?? 'all', 9);
        if ($academicYear !== 'all' && !master_valid_academic_year($academicYear)) fail('Choose a valid academic year.', 422);
        $semester = clean_text($_GET['semester'] ?? 'all', 10);
        if ($semester !== 'all' && !in_array($semester, ['1', '2', '3'], true)) fail('Choose a valid semester.', 422);
        $scope = clean_text($_GET['scope'] ?? 'all', 10);
        if (!in_array($scope, ['all', 'active', 'archived'], true)) fail('Choose a valid list status.', 422);
        $filters = ['academic_year' => $academicYear === 'all' ? '' : $academicYear, 'semester' => $semester === 'all' ? '' : $semester, 'scope' => $scope];
        $result = search_validation_records($filters, (int)($_GET['page'] ?? 1));
        foreach ($result['records'] as &$record) $record['enrollment_status'] = $record['list_status'] === 'ARCHIVED' ? 'Archived (read-only)' : 'Active';
        unset($record);
        json_response(['ok' => true, 'academic_year' => $academicYear, 'semester' => $semester, 'scope' => $scope] + $result);

    case 'periods':
        require_method('GET');
        json_response(['ok' => true,
            'academic_years' => array_column(fetch_all('SELECT DISTINCT academic_year FROM master_list_imports ORDER BY academic_year DESC'), 'academic_year'),
            'semesters' => SEMESTER_LABELS,
            'current_academic_year' => current_academic_year(),
            'can_edit_current_year' => $user['role'] === 'admin']);

    case 'set_current_year':
        require_method('POST');
        require_csrf();
        if ($user['role'] !== 'admin') fail('Only an administrator can change the current academic year.', 403);
        $academicYear = trim((string)($_POST['academic_year'] ?? ''));
        if (!master_valid_academic_year($academicYear)) fail('Choose a valid academic year (for example 2025-2026).', 422);
        $dryRun = !empty($_POST['preview']);
        $pdo = db();
        try {
            if ($dryRun) {
                $imports = fetch_all("SELECT id, academic_year, semester, status FROM master_list_imports WHERE status = 'ACTIVE' ORDER BY period_key");
                $toArchive = master_imports_to_archive($imports, $academicYear);
                $ids = master_archive_ids($imports, $academicYear);
                json_response(['ok' => true, 'academic_year' => $academicYear, 'current_academic_year' => current_academic_year(), 'will_archive' => array_map(
                    fn($i) => ['id' => (int)$i['id'], 'label' => master_period_label($i['academic_year'], $i['semester'])], $toArchive
                ), 'archive_ids' => $ids]);
            }

            $confirmed = json_decode((string)($_POST['confirmed_archive_ids'] ?? '[]'), true);
            if (!is_array($confirmed)) fail('The archive confirmation is invalid. Please review the change again.', 422);
            $confirmed = array_values(array_unique(array_map('intval', $confirmed)));
            sort($confirmed, SORT_NUMERIC);
            $confirmedCurrentYear = trim((string)($_POST['confirmed_current_academic_year'] ?? ''));
            if (!master_valid_academic_year($confirmedCurrentYear)) fail('Please review the current academic year before saving.', 422);

            $pdo->beginTransaction();
            query('INSERT IGNORE INTO academic_year_settings (id, academic_year, updated_by) VALUES (1, ?, ?)',
                [current_academic_year(), $user['id']]);
            $oldSetting = fetch_one('SELECT academic_year FROM academic_year_settings WHERE id = 1 FOR UPDATE');
            if ($oldSetting['academic_year'] !== $confirmedCurrentYear) {
                $pdo->rollBack();
                fail('The current academic year changed while you were reviewing this change. Please review it again.', 409);
            }
            $imports = fetch_all("SELECT id, academic_year, semester, status FROM master_list_imports WHERE status = 'ACTIVE' ORDER BY period_key FOR UPDATE");
            $toArchive = master_imports_to_archive($imports, $academicYear);
            $archiveIds = master_archive_ids($imports, $academicYear);
            if ($archiveIds !== $confirmed) {
                $pdo->rollBack();
                fail('The archive plan changed while you were reviewing it. Please review the change again.', 409);
            }
            $now = date('Y-m-d H:i:s');
            query('UPDATE academic_year_settings SET academic_year = ?, updated_by = ?, updated_at = ? WHERE id = 1',
                [$academicYear, $user['id'], $now]);
            foreach ($toArchive as $old) {
                $note = 'Archived after the current academic year was set to ' . $academicYear . '.';
                $changed = query("UPDATE master_list_imports SET status = 'ARCHIVED', archived_at = ?, archived_by = ?, archive_note = ? WHERE id = ? AND status = 'ACTIVE'",
                    [$now, $user['id'], $note, $old['id']])->rowCount();
                if ($changed) audit_log('masterlist_archive', 'master_list', (int)$old['id'], null, $user['id'], 'ACTIVE', 'ARCHIVED', $note);
            }
            if ($oldSetting['academic_year'] !== $academicYear) {
                audit_log('academic_year_change', 'master_list', null, null, $user['id'], $oldSetting['academic_year'], $academicYear, count($toArchive) . ' active list(s) archived.');
            }
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        json_response(['ok' => true, 'academic_year' => $academicYear, 'archived' => count($toArchive)]);

    case 'student_history':
        require_method('GET');
        $studentNo = clean_text($_GET['student_no'] ?? '', 30);
        if ($studentNo === '') fail('Student ID is required.', 422);
        json_response(['ok' => true, 'history' => student_validation_history($studentNo)]);

    case 'records':
        require_method('GET');
        $filters = [];
        foreach (['academic_year', 'semester', 'student_no', 'name', 'status', 'scope', 'archived_from', 'archived_to'] as $key) $filters[$key] = clean_text($_GET[$key] ?? '', 80);
        json_response(['ok' => true] + search_validation_records($filters, (int)($_GET['page'] ?? 1)));

    case 'check':
    case 'import':
        require_method('POST');
        require_csrf();
        $file = $_FILES['csv'] ?? null;
        if (!$file || $file['error'] === UPLOAD_ERR_NO_FILE) fail('Choose a CSV file first.', 422);
        if ($file['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) fail('The upload failed. Please try again.', 422);
        if ($file['size'] > 2 * 1024 * 1024) fail('The CSV file is too large (maximum 2 MB).', 422);
        if (strtolower(pathinfo($file['name'], PATHINFO_EXTENSION)) !== 'csv') fail('Please upload a .csv file.', 422);
        try {
            if ($action === 'check') json_response(['ok' => true] + check_master_list_file($file['tmp_name']));
            $confirmed = json_decode((string)($_POST['confirmed_archive_ids'] ?? '[]'), true);
            if (!is_array($confirmed)) fail('The archive confirmation is invalid. Please review the import again.', 422);
            $confirmed = array_values(array_unique(array_map('intval', $confirmed)));
            sort($confirmed, SORT_NUMERIC);
            $confirmedCurrentYear = trim((string)($_POST['confirmed_current_academic_year'] ?? ''));
            $newListWillArchive = ($_POST['confirmed_new_list_will_archive'] ?? '') === '1'
                ? true : (($_POST['confirmed_new_list_will_archive'] ?? '') === '0' ? false : null);
            $result = import_master_list($file['tmp_name'], $_POST['academic_year'] ?? '', $_POST['semester'] ?? '', $user, !empty($_POST['dry_run']),
                $confirmed, $confirmedCurrentYear, $newListWillArchive);
        } catch (RuntimeException $e) {
            fail($e->getMessage(), 422);
        }
        json_response(['ok' => true] + $result, $result['saved'] ? 201 : 200);

    default:
        fail('Unknown action.', 404);
}