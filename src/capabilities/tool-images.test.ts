import { withToolExecutionScope } from './tool-execution-scope.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_TOOL_IMAGES,
  captureToolImageState,
  holdImages,
  resetToolImages,
  setToolImagesAllowed,
  toolOutputWithImages,
  usableImages,
} from './tool-images.js';

const png = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };

afterEach(() => {
  resetToolImages();
  setToolImagesAllowed(true);
});

describe('tool images', () => {
  it('keeps supported types, within the size limit, up to the maximum count', () => {
    const images = usableImages([
      { data: 'x', mimeType: 'image/tiff' },
      { data: 'x'.repeat(8_000_001), mimeType: 'image/png' },
      ...Array.from({ length: 6 }, () => ({ ...png })),
    ]);
    expect(images).toHaveLength(MAX_TOOL_IMAGES);
    expect(images.every((image) => image.mimeType === 'image/png' && image.data === png.data)).toBe(true);
  });

  it('sends held images to the model as image parts', () => {
    holdImages('call-1', [png]);
    expect(toolOutputWithImages('call-1', 'shot')).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'shot' }, { type: 'image-data', data: png.data, mediaType: 'image/png' }],
    });
  });

  it('sends a note instead when the model cannot take images', () => {
    setToolImagesAllowed(false);
    holdImages('call-1', [png]);
    const output = toolOutputWithImages('call-1', 'shot');
    expect(output.type).toBe('text');
    expect(output.value).toMatch(/^shot\n\(The current model can't view images/);
  });

  it('returns plain text when nothing was held for the call', () => {
    holdImages(undefined, [png]);
    holdImages('call-2', []);
    expect(toolOutputWithImages('call-1', 'plain')).toEqual({ type: 'text', value: 'plain' });
    expect(toolOutputWithImages('call-2', 'plain')).toEqual({ type: 'text', value: 'plain' });
  });

  it('holds at most 32 calls, dropping the oldest', () => {
    for (let i = 0; i < 33; i++) holdImages(`call-${i}`, [png]);
    expect(toolOutputWithImages('call-0', 'old').type).toBe('text');
    expect(toolOutputWithImages('call-32', 'new').type).toBe('content');
  });
});


it('isolates provider attempts and retains captured output for the old attempt', () => {
  setToolImagesAllowed(true);
  const first = captureToolImageState();
  holdImages('same-id', [png], first);
  setToolImagesAllowed(false);
  expect(toolOutputWithImages('same-id', 'new').type).toBe('text');
  expect(toolOutputWithImages('same-id', 'old', first).type).toBe('content');
});

it('clears stale images when a call id is reused without an image', () => {
  holdImages('same-id', [png]);
  holdImages('same-id', []);
  expect(toolOutputWithImages('same-id', 'plain').type).toBe('text');
});


it('isolates overlapping turns even when their image call ids match', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withToolExecutionScope(async () => {
    setToolImagesAllowed(true);
    holdImages('same-id', [png]);
    const state = captureToolImageState();
    await gate;
    return () => toolOutputWithImages('same-id', 'first', state);
  });
  const second = await withToolExecutionScope(async () => {
    setToolImagesAllowed(false);
    holdImages('same-id', [{ ...png, data: 'second' }]);
    const state = captureToolImageState();
    release();
    return () => toolOutputWithImages('same-id', 'second', state);
  });
  expect((await first)().type).toBe('content');
  expect(second().type).toBe('text');
});
