// deno-lint-ignore-file jsx-button-has-type
import type { DestinationLinkProps } from "../contracts/views";
export interface NavigationViewProps {
  readonly breadcrumbs: readonly (DestinationLinkProps & {
    readonly id: string;
    readonly title: string;
    readonly current: boolean;
  })[];
  readonly onBack: () => void;
  readonly up?: DestinationLinkProps;
  readonly related: readonly (DestinationLinkProps & { readonly label: string })[];
}
export function NavigationView({ breadcrumbs, onBack, up, related }: NavigationViewProps) {
  return (
    <nav className="c4-navigation" aria-label="Diagram navigation">
      <div>
        <button onClick={onBack}>Back</button>
        {up ? <a {...up}>Up</a> : <button disabled>Up</button>}
      </div>
      <ol>
        {breadcrumbs.map((item) => (
          <li key={item.id}>
            <a href={item.href} onClick={item.onClick} aria-current={item.current ? "page" : undefined}>
              {item.title}
            </a>
          </li>
        ))}
      </ol>
      {related.map((item, i) => <a key={i} href={item.href} onClick={item.onClick}>{item.label}</a>)}
    </nav>
  );
}
