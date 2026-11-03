# For every Screen type, print the arity of its cursor mover(s). A mover with
# two parameters means a 2-axis grid (VoteScreen-style) and needs the (x, y)
# split; one parameter is the normal list. Anything with no mover falls back to
# writing the cursor field, which is only safe when the screen has no
# PointerEnter-style no-op guard.
import dnfile

DLL = r'C:\Program Files (x86)\Steam\steamapps\common\GNOSIA\Gnosia_Data\Managed\Assembly-CSharp.dll'
pe = dnfile.dnPE(DLL)

MOVERS = ('SelectTarget', 'SelectTargetCursor', 'SelectButton', 'SelectTargetColorBar',
          'SelectTargetTitle', 'SelectTargetChoice', 'SelectLv1', 'SelectLv2', 'SelectEventBtn')


def arity(method_row):
    params = getattr(method_row, 'ParamList', None)
    if params is None:
        return -1
    try:
        return len(params)
    except TypeError:
        return -1


rows = [t for t in pe.net.mdtables.TypeDef.rows if t.TypeName and 'Screen' in str(t.TypeName)]
print(f'{"type":30} movers (name/arity)')
for t in sorted(rows, key=lambda x: str(x.TypeName)):
    found = []
    for m in t.MethodList:
        row = getattr(m, 'row', None)
        if row is None or row.Name is None:
            continue
        n = str(row.Name)
        if n in MOVERS:
            found.append(f'{n}/{arity(row)}')
    if found:
        print(f'{str(t.TypeName):30} {", ".join(found)}')
