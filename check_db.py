import sqlite3
import json

conn = sqlite3.connect('cp_data.db')
conn.row_factory = sqlite3.Row

for row in conn.execute('SELECT id, name, type, data FROM projects').fetchall():
    d = json.loads(row['data']) if row['data'] else {}
    print('=== Project ID:', row['id'], 'Name:', row['name'])
    p = d.get('project', {})
    print('Target potential:', p.get('targetPotential'))
    cp = d.get('cp', {})
    print('CP Current (A):', cp.get('current'), 'requiredOnPot:', cp.get('requiredOnPotential'), 'offPot:', cp.get('offPotential'))
    iccp = d.get('iccp', {})
    print('ICCP Current (A):', iccp.get('current'), 'Voltage (V):', iccp.get('voltage'))
    rect = iccp.get('rectifierSelection', {}).get('selected', {})
    print('Selected Rectifier:', rect.get('model'), 'Nominal Current (A):', rect.get('nominalCurrent'), 'Nominal Voltage (V):', rect.get('nominalVoltage'))
    gb = d.get('groundbed', {}).get('results', {})
    print('Groundbed lifeDesign:', gb.get('lifeDesign'), 'R_total:', gb.get('R_total'), 'I_total:', gb.get('I_total'))
    
    # Check equipments table
    eq_rows = conn.execute('SELECT * FROM equipments WHERE project_id = ?', (row['id'],)).fetchall()
    print(f'Total Equipments in equipments table: {len(eq_rows)}')
    
    total_len_m = 0
    total_surf_m2 = 0
    rectifier_count = 0
    total_rectifier_current = 0
    groundbed_count = 0
    
    for eq in eq_rows:
        eq_data = json.loads(eq['data']) if eq['data'] else {}
        eq_type = eq['type']
        dims = eq_data.get('dimensions', {})
        length_m = dims.get('longueur_m', 0)
        diam_m = dims.get('diametre_m', 0)
        surf = eq['surface'] or 0
        
        if 'pipeline' in eq_type:
            total_len_m += length_m
            total_surf_m2 += surf
        elif 'rectifier' in eq_type:
            rectifier_count += 1
            total_rectifier_current += eq_data.get('nominalCurrent', 0) or eq_data.get('current', 0)
        elif 'groundbed' in eq_type:
            groundbed_count += 1
            
        print(f"  - {eq['tag']} ({eq_type}): len={length_m}m, diam={diam_m}m, surf={surf:.2f}m2, data={list(eq_data.keys())}")
        
    print(f"\nREAL TOTALS for {row['name']}:")
    print(f"  - Total pipeline length: {total_len_m} m ({total_len_m / 1000.0:.2f} km)")
    print(f"  - Total pipeline surface: {total_surf_m2:.2f} m²")
    print(f"  - Rectifiers (Postes de soutirage): {rectifier_count} poste(s)")
    print(f"  - Rectifier Current: {total_rectifier_current} A (Nominal) / {iccp.get('current', 0):.3f} A (Calculated ICCP Demand)")
    print(f"  - Groundbeds: {groundbed_count}")
    print(f"  - Target Potential (NACE SP0169): {p.get('targetPotential', -850)} mV CSE")

# Check users table
print("\n=== Users in DB:")
for u in conn.execute('SELECT id, username, role FROM users').fetchall():
    print('User:', dict(u))

conn.close()
