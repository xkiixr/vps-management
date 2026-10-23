import type { GithubRepository } from '@vpsm/db'

/**
 * The repositories the GitHub App can read, as suggestions for a repository field (`list={id}`). It is plain
 * HTML, so it works without script, and the field stays free text: any owner/name can still be typed. With
 * nothing to suggest it draws nothing.
 */
export function RepoDatalist({ id, repositories }: { id: string; repositories: Pick<GithubRepository, 'fullName' | 'defaultBranch'>[] }) {
  if (repositories.length === 0) return null
  return (
    <datalist id={id}>
      {repositories.map(({ fullName, defaultBranch }) => (
        <option key={fullName} value={fullName}>
          {`default branch ${defaultBranch}`}
        </option>
      ))}
    </datalist>
  )
}
