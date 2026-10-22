import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(webRoot, 'src')

/** Every .tsx file under apps/web/src, as a path relative to apps/web. */
function tsxFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.tsx'))
    .map((path) => relative(webRoot, join(srcRoot, path)))
    .sort()
}

// Next 16 (its bundled React Fizz) hangs the server at 100% CPU, never answers and ignores SIGTERM when a browser
// without script (or before hydration) submits a form whose action was bound with `.bind(` INSIDE the component
// that calls `useActionState(`: every render of that component makes a fresh pending Promise for the bound
// arguments, the server replaying the state of the hook throws it, and React retries the render for ever. The same
// request is fine when the action is bound in a parent, so the page binds and the form gets the finished action
// as a prop. A comment in such a file that spells either of the two calls out also fails this test: reword it.
describe('forms that use useActionState', () => {
  test('finds the files to look at', () => {
    const files = tsxFiles()
    expect(files.length).toBeGreaterThan(10)
    expect(files.filter((file) => readFileSync(join(webRoot, file), 'utf8').includes('useActionState(')).length).toBeGreaterThan(5)
  })

  test('never bind an action inside the component that calls useActionState: bind it in the page and pass it down', () => {
    const offenders = tsxFiles().filter((file) => {
      const source = readFileSync(join(webRoot, file), 'utf8')
      return source.includes('useActionState(') && source.includes('.bind(')
    })
    expect(
      offenders,
      [
        'These files call useActionState( and also .bind( in the same file.',
        'Bound inside the component that holds the state, a no-JS form post makes the Next 16 server spin at 100% CPU and never answer',
        '(React Fizz re-renders for ever on the pending Promise of the bound arguments, and SIGTERM is ignored).',
        'Bind the action in the parent server component (the page) and pass the bound action to the form as a prop:',
        'useActionState(action, initialState) with no .bind( in the form. The comment above this test has the details.',
      ].join('\n'),
    ).toEqual([])
  })
})
