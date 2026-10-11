import json
from concurrent.futures import ThreadPoolExecutor

import pytest

import backend


@pytest.fixture(scope='module')
def session_tokens():
    connection = backend.get_db()
    users = [
        ('owner-a', 'owner_a', 'viewer'),
        ('owner-b', 'owner_b', 'viewer'),
        ('admin-a', 'admin_a', 'admin'),
    ]
    for user_id, username, role in users:
        connection.execute(
            'INSERT INTO users (id, username, password_hash, role, created_at, disabled) '
            'VALUES (?, ?, ?, ?, ?, 0)',
            (user_id, username, 'unused-test-hash', role, '2026-01-01T00:00:00+00:00')
        )

    projects = [
        ('project-a', 'Project A', 'owner-a'),
        ('project-b', 'Project B', 'owner-b'),
        ('project-admin', 'Admin Project', 'admin-a'),
    ]
    for project_id, name, owner_id in projects:
        connection.execute(
            'INSERT INTO projects (id, name, type, created_at, updated_at, data, owner_id) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (project_id, name, 'mixte', '2026-01-01', '2026-01-01', '{}', owner_id)
        )
        connection.execute(
            'INSERT INTO equipments (id, project_id, tag, type, surface, included, data) '
            'VALUES (?, ?, ?, ?, ?, 1, ?)',
            (f'equipment-{owner_id}', project_id, f'PIPE-{owner_id}', 'pipeline_enterre', 10, '{}')
        )

    connection.commit()
    tokens = {}
    for user_id, _, _ in users:
        tokens[user_id] = backend._build_token(
            connection.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        )
    connection.close()
    return tokens


def test_dashboard_summary_requires_authentication():
    response = backend.app.test_client().get('/api/dashboard/summary')

    assert response.status_code == 401


def test_every_nonpublic_api_route_requires_authentication():
    public_routes = {'/api/login', '/api/version', '/api/v1/health'}
    client = backend.app.test_client()

    for rule in backend.app.url_map.iter_rules():
        if not rule.rule.startswith('/api/') or rule.rule in public_routes:
            continue

        path = rule.rule.replace('<project_id>', 'security-project-id')
        path = path.replace('<equipment_id>', 'security-equipment-id')
        methods = rule.methods - {'HEAD', 'OPTIONS'}
        for method in methods:
            response = client.open(path, method=method, json={})
            assert response.status_code == 401, f'{method} {rule.rule} was not protected'


def test_dashboard_summary_only_returns_projects_owned_by_user(session_tokens):
    client = backend.app.test_client()
    response = client.get(
        '/api/dashboard/summary',
        headers={'Authorization': f"Bearer {session_tokens['owner-a']}"}
    )

    assert response.status_code == 200
    data = response.get_json()
    assert [project['id'] for project in data['projects']] == ['project-a']
    assert [equipment['projectId'] for equipment in data['equipments']] == ['project-a']


def test_new_project_is_visible_in_owner_workspace_and_not_other_users(session_tokens):
    client = backend.app.test_client()
    owner_headers = {'Authorization': f"Bearer {session_tokens['owner-a']}"}
    other_headers = {'Authorization': f"Bearer {session_tokens['owner-b']}"}
    payload = {
        'id': 'PROJ-004',
        'name': 'Feeder Gaz Sud',
        'type': 'mixte',
        'data': {
            'project': {
                'id': 'PROJ-004',
                'name': 'Feeder Gaz Sud',
                'standard': 'ISO 15589-1',
                'cpSystemType': 'mixte',
                'pipelineLengthKm': 10,
                'pipelineDiameterMm': 254,
                'soilResistivity': 100,
            }
        },
    }

    created = client.post('/api/projects', headers=owner_headers, json=payload)
    assert created.status_code == 201
    assert created.get_json()['id'] == 'PROJ-004'

    project_list = client.get('/api/projects', headers=owner_headers).get_json()
    assert 'PROJ-004' in {project['id'] for project in project_list['items']}

    summary = client.get('/api/dashboard/summary', headers=owner_headers)
    assert summary.status_code == 200
    assert 'PROJ-004' in {project['id'] for project in summary.get_json()['projects']}

    other_summary = client.get('/api/dashboard/summary', headers=other_headers)
    assert other_summary.status_code == 200
    assert 'PROJ-004' not in {project['id'] for project in other_summary.get_json()['projects']}

    duplicate = client.post('/api/projects', headers=owner_headers, json=payload)
    assert duplicate.status_code == 409

    # Keep the shared test database isolated for the remaining tests.
    connection = backend.get_db()
    connection.execute('DELETE FROM projects WHERE id = ?', ('PROJ-004',))
    connection.commit()
    connection.close()


def test_admin_summary_is_scoped_to_owned_projects(session_tokens):
    response = backend.app.test_client().get(
        '/api/dashboard/summary',
        headers={'Authorization': f"Bearer {session_tokens['admin-a']}"}
    )

    assert response.status_code == 200
    data = response.get_json()
    assert {project['id'] for project in data['projects']} == {'project-admin'}
    assert {equipment['projectId'] for equipment in data['equipments']} == {'project-admin'}


def test_user_cannot_cross_project_boundary_with_tenant_header(session_tokens):
    client = backend.app.test_client()
    headers = {
        'Authorization': f"Bearer {session_tokens['owner-a']}",
        'X-Tenant-Id': 'owner-b',
    }

    assert client.get('/api/projects/project-b', headers=headers).status_code == 404
    assert client.get('/api/projects/project-b/equipments', headers=headers).status_code == 404

    project_list = client.get('/api/projects', headers=headers).get_json()
    assert {project['id'] for project in project_list['items']} == {'project-a'}


def test_project_update_rejects_stale_version_without_overwriting_data(session_tokens):
    client = backend.app.test_client()
    headers = {
        'Authorization': f"Bearer {session_tokens['owner-a']}",
        'If-Match': '1',
    }
    first = client.put('/api/projects/project-a', headers=headers, json={'revision': 'first'})
    stale = client.put('/api/projects/project-a', headers=headers, json={'revision': 'stale'})

    assert first.status_code == 200
    assert first.get_json()['version'] == 2
    assert stale.status_code == 409
    assert stale.get_json()['currentVersion'] == 2

    connection = backend.get_db()
    project = connection.execute('SELECT data FROM projects WHERE id = ?', ('project-a',)).fetchone()
    connection.close()
    assert json.loads(project['data']) == {'revision': 'first'}


def test_existing_project_writes_require_version_and_preserve_data(session_tokens):
    client = backend.app.test_client()
    headers = {'Authorization': f"Bearer {session_tokens['owner-b']}"}

    update = client.put('/api/projects/project-b', headers=headers, json={'revision': 'unversioned'})
    full_sync = client.post(
        '/api/projects/project-b/full-sync',
        headers=headers,
        json={'project': {'name': 'Project B'}, 'equipments': []}
    )
    create_equipment = client.post(
        '/api/equipments',
        headers=headers,
        json={
            'id': 'equipment-unversioned',
            'projectId': 'project-b',
            'tag': 'PIPE-NEW',
            'type': 'pipeline_enterre',
            'surface': 20,
        }
    )
    update_equipment = client.put(
        '/api/equipments/equipment-owner-b',
        headers=headers,
        json={
            'id': 'equipment-owner-b',
            'projectId': 'project-b',
            'tag': 'PIPE-CHANGED',
            'type': 'pipeline_enterre',
            'surface': 20,
        }
    )
    delete_equipment = client.delete('/api/equipments/equipment-owner-b', headers=headers)
    delete_project = client.delete('/api/projects/project-b', headers=headers)

    assert [
        update.status_code,
        full_sync.status_code,
        create_equipment.status_code,
        update_equipment.status_code,
        delete_equipment.status_code,
        delete_project.status_code,
    ] == [428, 428, 428, 428, 428, 428]
    assert update.get_json()['error'] == 'PROJECT_VERSION_REQUIRED'

    connection = backend.get_db()
    project = connection.execute(
        'SELECT data, version FROM projects WHERE id = ?', ('project-b',)
    ).fetchone()
    equipment_count = connection.execute(
        'SELECT COUNT(*) AS count FROM equipments WHERE project_id = ?', ('project-b',)
    ).fetchone()['count']
    connection.close()

    assert json.loads(project['data']) == {}
    assert project['version'] == 1
    assert equipment_count == 1


def test_full_sync_rejects_stale_snapshot_before_deleting_equipment(session_tokens):
    client = backend.app.test_client()
    headers = {
        'Authorization': f"Bearer {session_tokens['owner-a']}",
        'If-Match': '0',
    }
    response = client.post(
        '/api/projects/project-a/full-sync',
        headers=headers,
        json={'project': {'name': 'Project A'}, 'equipments': []}
    )

    assert response.status_code == 409
    connection = backend.get_db()
    row = connection.execute(
        'SELECT COUNT(*) AS count FROM equipments WHERE project_id = ?',
        ('project-a',)
    ).fetchone()
    connection.close()
    assert row['count'] == 1


def test_full_sync_increments_version_for_valid_snapshot(session_tokens):
    response = backend.app.test_client().post(
        '/api/projects/project-a/full-sync',
        headers={
            'Authorization': f"Bearer {session_tokens['owner-a']}",
            'If-Match': '2',
        },
        json={'project': {'name': 'Project A'}, 'equipments': []}
    )

    assert response.status_code == 200
    assert response.get_json()['version'] == 3


def test_stale_equipment_update_is_rejected_without_overwriting(session_tokens):
    response = backend.app.test_client().put(
        '/api/equipments/equipment-owner-b',
        headers={
            'Authorization': f"Bearer {session_tokens['owner-b']}",
            'If-Match': '0',
        },
        json={
            'id': 'equipment-owner-b',
            'projectId': 'project-b',
            'tag': 'PIPE-CHANGED',
            'type': 'pipeline_enterre',
            'surface': 20,
        }
    )

    assert response.status_code == 409
    connection = backend.get_db()
    equipment = connection.execute(
        'SELECT tag FROM equipments WHERE id = ?', ('equipment-owner-b',)
    ).fetchone()
    connection.close()
    assert equipment['tag'] == 'PIPE-owner-b'


def test_concurrent_full_sync_serializes_and_rejects_stale_snapshot(session_tokens):
    def submit_snapshot(_):
        return backend.app.test_client().post(
            '/api/projects/project-b/full-sync',
            headers={
                'Authorization': f"Bearer {session_tokens['owner-b']}",
                'If-Match': '1',
            },
            json={
                'project': {'name': 'Project B'},
                'equipments': [{
                    'id': 'equipment-owner-b',
                    'projectId': 'project-b',
                    'tag': 'PIPE-owner-b',
                    'type': 'pipeline_enterre',
                    'surface': 10,
                    'included': True,
                }]
            }
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        statuses = list(executor.map(submit_snapshot, range(2)))

    assert sorted(statuses) == [200, 409]
    connection = backend.get_db()
    row = connection.execute(
        'SELECT COUNT(*) AS count FROM equipments WHERE project_id = ?',
        ('project-b',)
    ).fetchone()
    connection.close()
    assert row['count'] == 1


def test_delete_project_removes_it_and_its_equipments_from_dashboard_summary(session_tokens):
    """Studio → Backend : supprimer un projet le retire du résumé Dashboard.

    Le proxy storage-proxy.js appelle DELETE /api/projects/<id> (If-Match),
    la FK ON DELETE CASCADE supprime les équipements, et /api/dashboard/summary
    ne renvoie plus le projet : les KPI Dashboard se recalculent sans lui.
    """
    client = backend.app.test_client()
    headers = {'Authorization': f"Bearer {session_tokens['owner-a']}"}

    # 1. Projet dédié (n'affecte pas les autres tests qui partagent la DB).
    created = client.post('/api/projects', headers=headers, json={
        'id': 'PROJ-DEL', 'name': 'Projet À Supprimer', 'type': 'mixte', 'data': {}
    })
    assert created.status_code == 201

    # 2. Un équipement rattaché (version projet courante = 1).
    equipment = client.post('/api/equipments', headers={**headers, 'If-Match': '1'}, json={
        'id': 'equip-del', 'projectId': 'PROJ-DEL', 'tag': 'PIPE-DEL',
        'type': 'pipeline_enterre', 'surface': 5,
    })
    assert equipment.status_code == 201

    # 3. Visible dans le résumé (ce que lit le Dashboard).
    summary = client.get('/api/dashboard/summary', headers=headers).get_json()
    assert 'PROJ-DEL' in {p['id'] for p in summary['projects']}
    assert 'PROJ-DEL' in {e['projectId'] for e in summary['equipments']}

    # 4. DELETE sans If-Match → 428 (garde-fou de version).
    unversioned = client.delete('/api/projects/PROJ-DEL', headers=headers)
    assert unversioned.status_code == 428

    # 5. DELETE avec la version courante → 200.
    version = client.get('/api/projects/PROJ-DEL', headers=headers).get_json()['version']
    deleted = client.delete('/api/projects/PROJ-DEL', headers={**headers, 'If-Match': str(version)})
    assert deleted.status_code == 200

    # 6. Projet ET équipements (cascade FK) disparaissent du résumé.
    summary = client.get('/api/dashboard/summary', headers=headers).get_json()
    assert 'PROJ-DEL' not in {p['id'] for p in summary['projects']}
    assert 'PROJ-DEL' not in {e['projectId'] for e in summary['equipments']}
    connection = backend.get_db()
    remaining = connection.execute(
        'SELECT COUNT(*) AS count FROM equipments WHERE project_id = ?', ('PROJ-DEL',)
    ).fetchone()['count']
    connection.close()
    assert remaining == 0

    # 7. Re-suppression → 404 (le proxy de suppression tolère ce cas).
    again = client.delete('/api/projects/PROJ-DEL', headers={**headers, 'If-Match': str(version)})
    assert again.status_code == 404


def test_old_database_migrates_projects_version_column(tmp_path, monkeypatch):
    database_path = tmp_path / 'legacy.db'
    connection = backend.sqlite3.connect(database_path)
    connection.execute(
        'CREATE TABLE projects ('
        'id TEXT PRIMARY KEY, name TEXT, type TEXT, created_at TEXT, '
        'updated_at TEXT, data TEXT, owner_id TEXT)'
    )
    connection.execute(
        'INSERT INTO projects (id, name, type, created_at, updated_at, data, owner_id) '
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        ('legacy-project', 'Legacy', 'mixte', '2026-01-01', '2026-01-01', '{}', None)
    )
    connection.commit()
    connection.close()

    monkeypatch.setattr(backend, 'DB_PATH', str(database_path))
    backend.init_db()
    connection = backend.get_db()
    row = connection.execute('SELECT version FROM projects WHERE id = ?', ('legacy-project',)).fetchone()
    connection.close()

    assert row['version'] == 1