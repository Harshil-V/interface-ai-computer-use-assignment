import { useState, type FormEvent } from 'react';
import { lookupMember, type MemberLookupResult } from '../domain/memberLookup';
import type { Member } from '../fixtures/members';
import { formatCurrency } from '../utils/formatCurrency';

interface MemberLookupScreenProps {
  onViewMemberDetail: (member: Member) => void;
}

export function MemberLookupScreen({ onViewMemberDetail }: MemberLookupScreenProps) {
  const [memberIdInput, setMemberIdInput] = useState('');
  const [result, setResult] = useState<MemberLookupResult | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(lookupMember(memberIdInput));
  }

  return (
    <section aria-labelledby="lookup-heading">
      <h1 id="lookup-heading">Member lookup</h1>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="memberId">Member ID</label>
          <input
            id="memberId"
            name="memberId"
            type="text"
            value={memberIdInput}
            onChange={(event) => setMemberIdInput(event.target.value)}
            aria-invalid={result?.status === 'invalid'}
            aria-describedby={result?.status === 'invalid' ? 'lookup-validation-error' : undefined}
          />
        </div>
        <button type="submit">Look up member</button>
      </form>

      {result?.status === 'invalid' && (
        <p id="lookup-validation-error" role="alert" className="error-banner">
          {result.reason}
        </p>
      )}

      {result?.status === 'not_found' && (
        <p role="alert" className="error-banner">
          No member found for ID {result.memberId}.
        </p>
      )}

      {result?.status === 'found' && (
        <table>
          <caption>Search result</caption>
          <thead>
            <tr>
              <th scope="col">Member ID</th>
              <th scope="col">Savings balance</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{result.member.id}</td>
              <td>{formatCurrency(result.member.savingsBalance)}</td>
              <td>
                <button
                  type="button"
                  aria-label={`View details for member ${result.member.id}`}
                  onClick={() => onViewMemberDetail(result.member)}
                >
                  View details
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
