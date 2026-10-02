import sys

def check_js(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    stack = []
    in_string = None
    in_comment = False
    in_block_comment = False
    escape = False
    line = 1
    col = 0
    i = 0
    n = len(content)
    errors = []

    while i < n:
        c = content[i]
        col += 1
        if c == '\n':
            line += 1
            col = 0
            if in_comment:
                in_comment = False
            i += 1
            continue

        if in_comment:
            i += 1
            continue

        if in_block_comment:
            if c == '*' and i + 1 < n and content[i+1] == '/':
                in_block_comment = False
                i += 2
                col += 1
                continue
            i += 1
            continue

        if in_string:
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif in_string == '`' and c == '$' and i + 1 < n and content[i+1] == '{':
                stack.append(('${', line, col))
                in_string = None
                i += 2
                col += 1
                continue
            elif c == in_string:
                in_string = None
            i += 1
            continue

        if c == '/' and i + 1 < n and content[i+1] == '/':
            in_comment = True
            i += 2
            col += 1
            continue
        if c == '/' and i + 1 < n and content[i+1] == '*':
            in_block_comment = True
            i += 2
            col += 1
            continue
        if c in ('"', "'", '`'):
            in_string = c
            i += 1
            continue

        if c in '({[':
            stack.append((c, line, col))
        elif c in ')}]':
            if not stack:
                errors.append(f'Unexpected {c} at line {line}:{col}')
            else:
                top, tl, tc = stack.pop()
                match = {'(': ')', '{': '}', '[': ']', '${': '}'}
                if match.get(top) != c:
                    errors.append(f'Mismatched {top} (line {tl}:{tc}) and {c} (line {line}:{col})')
                elif top == '${':
                    in_string = '`'
        i += 1

    if stack:
        for s, l, c in stack:
            errors.append(f'Unclosed {s} opened at line {l}:{c}')

    if errors:
        print('ERRORS FOUND:')
        for e in errors[:10]:
            print(e)
        return False
    else:
        print(f'{filepath}: ALL BRACKETS, PARENS, TEMPLATES, AND STRINGS BALANCED AND VALID')
        return True

if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else 'app.js'
    ok = check_js(target)
    sys.exit(0 if ok else 1)
