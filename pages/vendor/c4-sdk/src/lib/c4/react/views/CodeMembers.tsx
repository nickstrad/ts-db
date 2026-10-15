import type { Element, Visibility } from "../../domain/model";
import { memberKey } from "../../domain/codeview";
const marks: Readonly<Record<Visibility, string>> = {
  public: "+",
  protected: "#",
  private: "-",
  package: "~",
};
/** Props-only member compartment. Declarations are literal text, never parsed or executed. */
export function CodeMembers({ element }: { element: Element }) {
  if (element.kind !== "code") return null;
  if (!element.members.length) return <p className="c4-members c4-members-empty">No declared members</p>;
  return (
    <ul className="c4-members" aria-label={`Members of ${element.name}`}>
      {element.members.map((member, index) => (
        <li key={memberKey(element.id, index)} data-member-key={memberKey(element.id, index)}>
          <span aria-hidden="true" className="c4-member-mark">{marks[member.visibility]}</span>
          <span className="c4-sr-only">{member.visibility}</span>
          <span className="c4-member-name">{member.name}</span>
          {member.signature ? <code className="c4-member-signature">{member.signature}</code> : null}
        </li>
      ))}
    </ul>
  );
}
