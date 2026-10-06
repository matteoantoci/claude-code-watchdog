type Block = { readonly type: string; readonly [field: string]: unknown };

type Row = {
  readonly message: { readonly type: string; readonly role?: string; readonly content: readonly Block[] };
};

const blockText = (block: Block): string => {
  if (typeof block.text === 'string') {
    return block.text;
  }
  if (block.type === 'tool_use') {
    return `Tool call ${typeof block.name === 'string' ? block.name : 'tool'}: ${JSON.stringify(block.input)}`;
  }
  if (block.type === 'tool_result') {
    return `Tool result: ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`;
  }
  return `[${block.type}]`;
};

// One `session.append` row as plain text: its role, then one line for each block. §7.6 gives the full
// format (omp markdown, labels, caps).
export const renderRow = (row: Row): string =>
  `${row.message.role ?? row.message.type}: ${row.message.content.map(blockText).join('\n')}`;
