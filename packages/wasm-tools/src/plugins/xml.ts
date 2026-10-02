interface XmlInput {
  xml: string;
  query?: string;
}

interface XmlNode {
  type: 'element' | 'text' | 'cdata' | 'comment';
  name?: string;
  attributes?: Record<string, string>;
  children?: XmlNode[];
  value?: string;
}

type XmlResult = XmlNode | XmlNode[] | string | string[] | null;

interface XmlOutput {
  result: XmlResult;
  type: 'document' | 'element' | 'text' | 'array' | 'empty';
  error?: string;
}

function parseXml(xml: string): XmlNode {
  let pos = 0;

  const skipWhitespace = () => {
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;
  };

  const NAME_CHAR = /[\w:.\-\u00B7-\uFFFF]/;

  const readName = (): string => {
    let name = '';
    while (pos < xml.length && NAME_CHAR.test(xml[pos])) {
      name += xml[pos++];
    }
    return name;
  };

  const parseAttributes = (): Record<string, string> => {
    const attrs: Record<string, string> = {};

    while (pos < xml.length) {
      skipWhitespace();

      if (xml[pos] === '>' || xml[pos] === '/' || xml[pos] === '?') break;

      const name = readName();

      if (!name) throw new Error(`Invalid attribute name at position ${pos}`);

      skipWhitespace();

      if (xml[pos] !== '=') {
        attrs[name] = 'true';
        continue;
      }
      pos++;

      skipWhitespace();

      const quote = xml[pos];
      if (quote !== '"' && quote !== "'") {
        throw new Error(`Expected quote at position ${pos}`);
      }
      pos++;

      let value = '';
      while (pos < xml.length && xml[pos] !== quote) {
        if (xml[pos] === '&') {
          const entity = parseEntity();
          value += entity;
        } else {
          value += xml[pos++];
        }
      }
      if (pos >= xml.length) throw new Error(`Unterminated attribute value for "${name}"`);
      pos++;

      attrs[name] = value;
    }

    return attrs;
  };

  const parseEntity = (): string => {
    const match = /^&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][\w.-]{0,31});/.exec(
      xml.slice(pos, pos + 40)
    );
    if (!match) {
      pos++;
      return '&';
    }
    const entity = match[1];
    pos += match[0].length;

    switch (entity) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (entity.startsWith('#')) {
          const code = entity.startsWith('#x')
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0) {
            throw new Error(`Invalid character reference: &${entity};`);
          }
          return String.fromCodePoint(code);
        }
        return `&${entity};`;
    }
  };

  const parseText = (): string => {
    let text = '';
    while (pos < xml.length && xml[pos] !== '<') {
      if (xml[pos] === '&') {
        text += parseEntity();
      } else {
        text += xml[pos++];
      }
    }
    return text;
  };

  const parseNode = (): XmlNode | null => {
    skipWhitespace();

    if (pos >= xml.length) return null;

    if (xml[pos] !== '<') {
      const text = parseText().trim();
      if (text) {
        return { type: 'text', value: text };
      }
      return null;
    }

    pos++;

    if (xml.slice(pos, pos + 3) === '!--') {
      pos += 3;
      const endPos = xml.indexOf('-->', pos);
      if (endPos === -1) throw new Error('Unclosed comment');
      const value = xml.slice(pos, endPos);
      pos = endPos + 3;
      return { type: 'comment', value };
    }

    if (xml.slice(pos, pos + 8) === '![CDATA[') {
      pos += 8;
      const endPos = xml.indexOf(']]>', pos);
      if (endPos === -1) throw new Error('Unclosed CDATA');
      const value = xml.slice(pos, endPos);
      pos = endPos + 3;
      return { type: 'cdata', value };
    }

    if (xml[pos] === '?') {
      const endPos = xml.indexOf('?>', pos);
      if (endPos === -1) throw new Error('Unclosed processing instruction');
      pos = endPos + 2;
      return null;
    }

    if (xml[pos] === '!') {
      let depth = 0;
      while (pos < xml.length) {
        const ch = xml[pos++];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
      }
      if (xml[pos - 1] !== '>') throw new Error('Unclosed declaration');
      return null;
    }

    if (xml[pos] === '/') {
      throw new Error(`Unexpected closing tag at position ${pos - 1}`);
    }

    const name = readName();

    if (!name) throw new Error(`Expected element name at position ${pos}`);

    const attributes = parseAttributes();

    skipWhitespace();

    if (xml.slice(pos, pos + 2) === '/>') {
      pos += 2;
      return { type: 'element', name, attributes, children: [] };
    }

    if (xml[pos] !== '>') {
      throw new Error(`Expected > at position ${pos}`);
    }
    pos++;

    const children: XmlNode[] = [];
    let closed = false;

    while (pos < xml.length) {
      skipWhitespace();

      if (xml.slice(pos, pos + 2) === '</') {
        pos += 2;
        const closeName = readName();
        skipWhitespace();
        if (xml[pos] !== '>') throw new Error(`Expected > at position ${pos}`);
        pos++;

        if (closeName !== name) {
          throw new Error(`Mismatched tags: ${name} vs ${closeName}`);
        }
        closed = true;
        break;
      }

      const child = parseNode();
      if (child) {
        children.push(child);
      }
    }

    if (!closed) {
      throw new Error(`Unclosed element: <${name}>`);
    }

    return { type: 'element', name, attributes, children };
  };

  let root: XmlNode | null = null;
  while (pos < xml.length) {
    const node = parseNode();
    if (!node) continue;
    if (node.type === 'comment') continue;
    if (node.type !== 'element') throw new Error('Text content outside the root element');
    if (root) throw new Error('Multiple root elements');
    root = node;
  }
  if (!root) throw new Error('Empty document');

  return root;
}

interface QueryStep {
  axis: 'child' | 'descendant';
  test: string;
  index?: number;
}

function parseQuery(query: string): {
  absolute: boolean;
  steps: QueryStep[];
  attribute?: string;
  text: boolean;
} {
  let rest = query.trim();
  if (!rest) throw new Error('Empty query');

  let attribute: string | undefined;
  let text = false;
  const attrMatch = /\/?@([\w:.-]+|\*)$/.exec(rest);
  if (attrMatch) {
    attribute = attrMatch[1];
    rest = rest.slice(0, rest.length - attrMatch[0].length);
  } else if (rest.endsWith('/text()')) {
    text = true;
    rest = rest.slice(0, -'/text()'.length);
  }

  const absolute = rest.startsWith('/');
  const steps: QueryStep[] = [];
  let i = 0;
  while (i < rest.length) {
    let axis: QueryStep['axis'] = 'child';
    if (rest.startsWith('//', i)) {
      axis = 'descendant';
      i += 2;
    } else if (rest[i] === '/') {
      i += 1;
    }
    const match = /^([\w:.\-·-￿]+|\*)(?:\[(\d+)\])?/.exec(rest.slice(i));
    if (!match) {
      if (i >= rest.length) break;
      throw new Error(`Invalid query near "${rest.slice(i)}"`);
    }
    const index = match[2] !== undefined ? parseInt(match[2], 10) : undefined;
    if (index !== undefined && index < 1) throw new Error('Query indexes are 1-based');
    steps.push({ axis, test: match[1], index });
    i += match[0].length;
  }

  return { absolute, steps, attribute, text };
}

function elementChildren(node: XmlNode): XmlNode[] {
  return (node.children ?? []).filter((c) => c.type === 'element');
}

function matchesTest(node: XmlNode, test: string): boolean {
  return node.type === 'element' && (test === '*' || node.name === test);
}

function collectDescendantsOrSelf(node: XmlNode, out: XmlNode[]): void {
  out.push(node);
  for (const child of elementChildren(node)) collectDescendantsOrSelf(child, out);
}

function textOf(node: XmlNode): string {
  if (node.type === 'text' || node.type === 'cdata') return node.value ?? '';
  if (node.type !== 'element') return '';
  return (node.children ?? []).map(textOf).join('');
}

function queryXml(root: XmlNode, query: string): XmlResult {
  const { absolute, steps, attribute, text } = parseQuery(query);
  const documentNode: XmlNode = { type: 'element', name: '#document', children: [root] };
  let context: XmlNode[] = [absolute ? documentNode : root];

  for (const step of steps) {
    const next: XmlNode[] = [];
    for (const node of context) {
      let candidates: XmlNode[];
      if (step.axis === 'descendant') {
        const all: XmlNode[] = [];
        for (const child of elementChildren(node)) collectDescendantsOrSelf(child, all);
        candidates = all.filter((n) => matchesTest(n, step.test));
      } else {
        candidates = elementChildren(node).filter((n) => matchesTest(n, step.test));
      }
      if (step.index !== undefined) {
        const picked = candidates[step.index - 1];
        if (picked) next.push(picked);
      } else {
        next.push(...candidates);
      }
    }
    context = next.filter((node, index) => next.indexOf(node) === index);
  }

  if (attribute !== undefined) {
    const values: string[] = [];
    for (const node of context) {
      const attrs = node.attributes ?? {};
      if (attribute === '*') values.push(...Object.values(attrs));
      else if (Object.prototype.hasOwnProperty.call(attrs, attribute))
        values.push(attrs[attribute]);
    }
    if (values.length === 0) return null;
    return values.length === 1 ? values[0] : values;
  }

  if (text) {
    const values = context.map(textOf);
    if (values.length === 0) return null;
    return values.length === 1 ? values[0] : values;
  }

  if (context.length === 0) return null;
  return context.length === 1 ? context[0] : context;
}

export function xml(): number {
  try {
    const inputStr = Host.inputString();
    const input: XmlInput = JSON.parse(inputStr);
    if (typeof input.xml !== 'string') {
      throw new Error('xml must be a string');
    }

    const parsed = parseXml(input.xml);

    let result: XmlResult = parsed;
    let type: XmlOutput['type'] = 'document';

    if (input.query) {
      result = queryXml(parsed, input.query);

      if (result === null) {
        type = 'empty';
      } else if (typeof result === 'string') {
        type = 'text';
      } else if (Array.isArray(result)) {
        type = 'array';
      } else {
        type = 'element';
      }
    }

    const output: XmlOutput = {
      result,
      type,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: XmlOutput = {
      result: null,
      type: 'document',
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
