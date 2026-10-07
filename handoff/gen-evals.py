"""Writes evals/docs-tree-tests/<id>/{PROMPT.md,EVAL.ts} from a final tasks JSON."""
import json, sys, os, shutil
tasks = json.load(open(sys.argv[1]))
root = '../evals/docs-tree-tests'
for name in os.listdir(root):
    if '-tree-' in name: shutil.rmtree(os.path.join(root, name))
def ts_list(items):
    if not items: return '[]'
    one = '[' + ', '.join(f"'{i}'" for i in items) + ']'
    if len(one) < 60: return one
    return '[\n' + ''.join(f"  '{i}',\n" for i in items) + ']'
for t in tasks:
    d = os.path.join(root, t['id']); os.makedirs(d)
    fm = ['---', f"stage: {t['stage']}", 'interface: mcp', 'product:'] + [f'  - {p}' for p in t['product']] + ['topic:'] + [f'  - {p}' for p in t['topic']] + [f"motivation: {t['motivation']}", '---', '', t['prompt'].strip(), '', "Find the page in the Supabase docs navigation where you'd expect the answer, and choose it.", '']
    open(os.path.join(d, 'PROMPT.md'), 'w').write('\n'.join(fm))
    alt_type = '' if t['alternates'] else ': string[]'
    ev = f"""import {{ treeTestScorer }} from '../lib/tree-test.js';

export const TARGETS = {ts_list(t['targets'])};
export const ALTERNATES{alt_type} = {ts_list(t['alternates'])};

export default treeTestScorer(TARGETS, ALTERNATES);
"""
    open(os.path.join(d, 'EVAL.ts'), 'w').write(ev)
print(len(tasks), 'evals written')
