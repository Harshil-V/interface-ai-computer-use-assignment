import { useEffect, useState } from 'react';
import type { Member } from './fixtures/members';
import type { SubAccountFormInput } from './domain/subAccountValidation';
import { useSession } from './hooks/useSession';
import { MemberLookupScreen } from './components/MemberLookupScreen';
import { MemberDetailScreen } from './components/MemberDetailScreen';
import { OpenSubAccountScreen } from './components/OpenSubAccountScreen';
import { SubAccountConfirmationScreen } from './components/SubAccountConfirmationScreen';
import { SubAccountCreatedScreen } from './components/SubAccountCreatedScreen';
import { DevToolsPanel } from './components/DevToolsPanel';

type Screen =
  | { name: 'lookup' }
  | { name: 'detail'; member: Member }
  | { name: 'openSubAccount'; member: Member }
  | { name: 'confirmSubAccount'; member: Member; formInput: SubAccountFormInput }
  | { name: 'subAccountCreated'; member: Member; formInput: SubAccountFormInput };

/** Any click or keypress counts as activity, resetting the idle-expiry clock (see hooks/useSession.ts). */
const ACTIVITY_EVENT_TYPES = ['click', 'keydown'] as const;

function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'lookup' });
  const { isExpired, recordActivity, forceExpire } = useSession();

  useEffect(() => {
    const handleActivity = () => recordActivity();
    for (const eventType of ACTIVITY_EVENT_TYPES) {
      window.addEventListener(eventType, handleActivity);
    }
    return () => {
      for (const eventType of ACTIVITY_EVENT_TYPES) {
        window.removeEventListener(eventType, handleActivity);
      }
    };
  }, [recordActivity]);

  function goToLookup() {
    setScreen({ name: 'lookup' });
  }

  function reestablishSessionAndReturnToLookup() {
    recordActivity();
    goToLookup();
  }

  return (
    <main>
      {screen.name === 'lookup' && (
        <MemberLookupScreen onViewMemberDetail={(member) => setScreen({ name: 'detail', member })} />
      )}

      {screen.name === 'detail' && (
        <MemberDetailScreen
          member={screen.member}
          isSessionExpired={isExpired}
          onReestablishSession={reestablishSessionAndReturnToLookup}
          onOpenSubAccount={() => setScreen({ name: 'openSubAccount', member: screen.member })}
          onBackToLookup={goToLookup}
        />
      )}

      {screen.name === 'openSubAccount' && (
        <OpenSubAccountScreen
          member={screen.member}
          isSessionExpired={isExpired}
          onReestablishSession={reestablishSessionAndReturnToLookup}
          onContinueToConfirmation={(formInput) =>
            setScreen({ name: 'confirmSubAccount', member: screen.member, formInput })
          }
          onCancel={() => setScreen({ name: 'detail', member: screen.member })}
        />
      )}

      {screen.name === 'confirmSubAccount' && (
        <SubAccountConfirmationScreen
          member={screen.member}
          formInput={screen.formInput}
          isSessionExpired={isExpired}
          onReestablishSession={reestablishSessionAndReturnToLookup}
          onConfirm={() =>
            setScreen({ name: 'subAccountCreated', member: screen.member, formInput: screen.formInput })
          }
          onBackToEdit={() => setScreen({ name: 'openSubAccount', member: screen.member })}
        />
      )}

      {screen.name === 'subAccountCreated' && (
        <SubAccountCreatedScreen
          member={screen.member}
          formInput={screen.formInput}
          onBackToMemberDetail={() => setScreen({ name: 'detail', member: screen.member })}
          onBackToLookup={goToLookup}
        />
      )}

      <DevToolsPanel isSessionExpired={isExpired} onForceExpireSession={forceExpire} />
    </main>
  );
}

export default App;
