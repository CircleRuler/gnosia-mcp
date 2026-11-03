# Static audit: for every *Screen type, list the cursor / confirm fields and the
# handler methods that could short-circuit when the cursor field is pre-written.
# Read-only; no game interaction.
import dnfile

DLL = r'C:\Program Files (x86)\Steam\steamapps\common\GNOSIA\Gnosia_Data\Managed\Assembly-CSharp.dll'
pe = dnfile.dnPE(DLL)

CURSOR = {'select', 'selectTgt', 'selectX', 'selectY', 'selectNum', 'selectMax',
          'selectPos', 'selectTop', 'selectState', 'isDicision', 'enterSelect',
          'isMouseEnable', 'isBack', 'isSpeak', 'interfaceUpdate', 'isWait'}
HANDLERS = ('PointerEnter', 'SelectTarget', 'SelectLeftRight', 'Select', 'Enter')


def fields_of(t):
    out = []
    for f in t.FieldList:
        row = getattr(f, 'row', None)
        if row is not None and row.Name is not None:
            out.append(str(row.Name))
    return out


def methods_of(t):
    out = []
    for m in t.MethodList:
        row = getattr(m, 'row', None)
        if row is not None and row.Name is not None:
            out.append(str(row.Name))
    return out


rows = [t for t in pe.net.mdtables.TypeDef.rows
        if t.TypeName and 'Screen' in str(t.TypeName)]
print(f'{"type":28} {"cursor/confirm fields":60} handlers')
for t in sorted(rows, key=lambda x: str(x.TypeName)):
    name = str(t.TypeName)
    if name == 'Screen':
        continue
    fs = [f for f in fields_of(t) if f in CURSOR]
    ms = [m for m in methods_of(t) if m.startswith(HANDLERS)]
    if not fs and not ms:
        continue
    print(f'{name:28} {",".join(fs):60} {",".join(sorted(set(ms)))}')
