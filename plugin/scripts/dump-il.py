# Dump the IL of a type's methods from Assembly-CSharp.dll.
# Usage: python dump-il.py [TypeNameSubstring] [MethodSubstring]
import sys
import dnfile
from dncil.cil.body import CilMethodBody
from dncil.cil.body.reader import CilMethodBodyReaderBase
from dncil.clr.token import Token, StringToken

DLL = r"C:\Program Files (x86)\Steam\steamapps\common\GNOSIA\Gnosia_Data\Managed\Assembly-CSharp.dll"
type_filter = sys.argv[1] if len(sys.argv) > 1 else "InterfaceScreen"
method_filter = sys.argv[2].lower() if len(sys.argv) > 2 else ""

pe = dnfile.dnPE(DLL)

class Reader(CilMethodBodyReaderBase):
    def __init__(self, pe, row):
        self.pe = pe
        self.offset = pe.get_offset_from_rva(row.Rva)
    def read(self, n):
        data = self.pe.get_data(self.pe.get_rva_from_offset(self.offset), n)
        self.offset += n
        return data
    def tell(self):
        return self.offset
    def seek(self, offset):
        self.offset = offset
        return self.offset

def table_by_index(idx):
    # .NET metadata table numbers -> dnfile mdtables attribute names
    names = {
        0x01: "TypeRef", 0x02: "TypeDef", 0x04: "Field", 0x05: "MethodPtr",
        0x06: "MethodDef", 0x08: "Param", 0x09: "InterfaceImpl",
        0x0A: "MemberRef", 0x0B: "Constant", 0x0C: "CustomAttribute",
        0x0D: "FieldMarshal", 0x0E: "DeclSecurity", 0x0F: "ClassLayout",
        0x10: "FieldLayout", 0x11: "StandAloneSig", 0x12: "EventMap",
        0x14: "Event", 0x15: "PropertyMap", 0x17: "Property",
        0x18: "MethodSemantics", 0x19: "MethodImpl", 0x1A: "ModuleRef",
        0x1B: "TypeSpec", 0x1C: "ImplMap", 0x1D: "FieldRVA",
        0x20: "Assembly", 0x23: "AssemblyRef", 0x2B: "MethodSpec",
    }
    attr = names.get(idx)
    if attr is None:
        return None
    return getattr(pe.net.mdtables, attr, None)

def resolve_token(tok):
    if isinstance(tok, StringToken):
        try:
            return '"' + str(pe.net.user_strings.get_us(tok.rid).value) + '"'
        except Exception:
            return "str:" + str(tok.rid)
    table = table_by_index(tok.table)
    if table is None:
        return f"tok(0x{tok.table:02X}{tok.rid:06X})"
    try:
        row = table.rows[tok.rid - 1]
    except Exception:
        return f"tok(0x{tok.table:02X}{tok.rid:06X})"
    name = getattr(row, "Name", None)
    if name is None:
        return f"{type(row).__name__}#{tok.rid}"
    name = str(name)
    for attr in ("Class", "Parent", "Type", "TypeName"):
        ref = getattr(row, attr, None)
        inner = getattr(ref, "row", None) if ref is not None else None
        if inner is not None:
            t = getattr(inner, "TypeName", None)
            if t is None:
                t = getattr(inner, "Name", None)
            if t is not None:
                return f"{t}::{name}"
    return name

def dump_method(row, owner):
    name = str(row.Name)
    if method_filter and method_filter not in name.lower():
        return
    if not row.Rva:
        print(f"--- {owner}::{name} (abstract)")
        return
    try:
        body = CilMethodBody(Reader(pe, row))
    except Exception as e:
        print(f"--- {owner}::{name} (no body: {e})")
        return
    print(f"--- {owner}::{name}")
    base = body.instructions[0].offset
    for insn in body.instructions:
        op = str(insn.opcode)
        operand = ""
        if insn.operand is not None:
            if isinstance(insn.operand, Token):
                operand = resolve_token(insn.operand)
            elif op.startswith(("br", "ble", "blt", "bne", "beq", "bge", "bgt", "blt", "brtrue", "brfalse", "brnull", "brzero", "brinst")) and isinstance(insn.operand, int):
                operand = f"IL_{insn.operand - base:04x}"
            else:
                operand = str(insn.operand)
        print(f"  IL_{insn.offset - base:04x}: {op:<12} {operand}")

for typedef in pe.net.mdtables.TypeDef.rows:
    tname = str(typedef.TypeName)
    if type_filter.lower() not in tname.lower():
        continue
    for m in typedef.MethodList:
        row = m.row if hasattr(m, "row") else m
        if row is None:
            continue
        try:
            dump_method(row, tname)
        except Exception as e:
            print(f"! {tname}::{row.Name}: {e}")
