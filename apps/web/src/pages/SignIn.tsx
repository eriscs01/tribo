import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState, type SubmitEvent } from 'react';
import { api, ApiProblem, setCsrfToken, unwrap, type Schemas } from '../api/client.js';
import { sessionQuery } from '../api/queries.js';
import { m } from '../messages.js';
import { Field } from '../ui/Field.js';
import { ErrorNotice } from '../ui/Notice.js';
import { fieldErrorsOf } from '../ui/problem.js';

/** Where to go after sign-in: a path on this origin only, never another site. */
export function safeRedirect(target: string | undefined): string {
  return target !== undefined && target.startsWith('/') && !target.startsWith('//')
    ? target
    : '/trips';
}

export function SignInPage({ redirect }: { redirect?: string | undefined }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);

  const signIn = useMutation({
    mutationFn: (body: Schemas['LoginInput']) => unwrap(api.POST('/v1/auth/login', { body })),
    onSuccess: async (session) => {
      setCsrfToken(session.csrfToken);
      client.setQueryData(sessionQuery.queryKey, session);
      await navigate({ to: safeRedirect(redirect) });
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.code === 'mfa_required') codeInput.current?.focus();
    },
  });

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    const second = code.trim();
    signIn.mutate({
      username: username.trim(),
      password,
      ...(second === '' ? {} : useRecovery ? { recoveryCode: second } : { totp: second }),
    });
  };

  const error = signIn.error;
  const failure = error instanceof ApiProblem ? error.code : null;
  const fields = fieldErrorsOf(error);
  const notice =
    failure === 'mfa_required'
      ? m.signIn.needCode
      : failure === 'unauthenticated'
        ? m.signIn.wrong
        : undefined;

  return (
    <section className="narrow">
      <h1>{m.signIn.title}</h1>
      <form onSubmit={onSubmit} noValidate>
        <ErrorNotice error={error ?? undefined} {...(notice ? { message: notice } : {})} />
        <Field label={m.signIn.username} error={fields.username}>
          {(control) => (
            <input
              {...control}
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label={m.signIn.password} error={fields.password}>
          {(control) => (
            <input
              {...control}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label={useRecovery ? m.signIn.recoveryCode : m.signIn.code}
          hint={useRecovery ? m.signIn.recoveryHint : m.signIn.codeHint}
          error={useRecovery ? fields.recoveryCode : fields.totp}
          optional
        >
          {(control) => (
            <input
              {...control}
              ref={codeInput}
              name={useRecovery ? 'recoveryCode' : 'totp'}
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              {...(useRecovery
                ? {}
                : { inputMode: 'numeric' as const, pattern: '[0-9]{6}', maxLength: 6 })}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
          )}
        </Field>
        <button
          type="button"
          className="button-link"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setCode('');
          }}
        >
          {useRecovery ? m.signIn.useCode : m.signIn.useRecovery}
        </button>
        <button type="submit" disabled={signIn.isPending}>
          {signIn.isPending ? m.signIn.submitting : m.signIn.submit}
        </button>
      </form>
    </section>
  );
}
