import { useId, useState } from 'react'
import { MessageCircleQuestionMark } from 'lucide-react'
import type { PendingRequest } from '../../../engine/types'
import { ago } from '../../lib/words'
import { useCall } from './useCall'

interface Option {
  label: string
  description: string
}
interface Question {
  question: string
  header: string
  options: Option[]
  multiSelect: boolean
}

const text = (v: unknown) => (typeof v === 'string' ? v : '')

/** AskUserQuestion 입력 — { questions: [{ question, header, options: [{ label, description }], multiSelect }] }. 모양이 다른 것은 건너뛴다 */
function readQuestions(input: unknown): Question[] {
  const list = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) return []
  return list.flatMap((q): Question[] => {
    if (!q || typeof q !== 'object' || !text(q.question)) return []
    const options = Array.isArray(q.options)
      ? q.options.flatMap((o: unknown): Option[] => {
          const label = text((o as Option | null)?.label)
          return label ? [{ label, description: text((o as Option).description) }] : []
        })
      : []
    if (options.length === 0) return []
    return [{ question: q.question, header: text(q.header), options, multiSelect: q.multiSelect === true }]
  })
}

/** 고른 값 → 답 — 질문 문장마다 고른 보기 이름(여럿이면 보기 순서대로 ', ' 로 잇는다) */
function answersOf(questions: Question[], chosen: string[][]): Record<string, string> {
  return Object.fromEntries(
    questions.map((q, i) => [
      q.question,
      q.options
        .filter(o => chosen[i]?.includes(o.label))
        .map(o => o.label)
        .join(', '),
    ]),
  )
}

/** 질문 카드 — Claude 가 보기를 주고 묻는 것(AskUserQuestion). 다 고르면 [답 보내기], 아니면 '대답 안 함' */
export function QuestionCard({ request, now }: { request: PendingRequest; now: number }) {
  const { busy, error, call } = useCall()
  const questions = readQuestions(request.input)
  const [chosen, setChosen] = useState<string[][]>(() => questions.map(() => []))
  const name = useId()
  const complete = questions.length > 0 && questions.every((_, i) => (chosen[i]?.length ?? 0) > 0)

  const pick = (i: number, label: string, multi: boolean) =>
    setChosen(c =>
      c.map((cur, j) => {
        if (j !== i) return cur
        if (!multi) return [label]
        return cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label]
      }),
    )

  // 질문에는 허용류로 답할 수 없다(엔진이 거절) — 답(answer) 이나 거절(deny) 뿐
  const send = () =>
    call(() => window.dure.answerRequest(request.id, { type: 'answer', answers: answersOf(questions, chosen) }), 'hold')
  const skip = () => call(() => window.dure.answerRequest(request.id, { type: 'deny' }), 'hold')

  return (
    <section className="pin qc" aria-label="질문이 있어요">
      <div className="ask-h">
        <MessageCircleQuestionMark className="i qc-ic" aria-hidden="true" />
        <b className="ask-t">질문이 있어요</b>
        <span className="pin-t">{ago(request.createdAt, now)}</span>
      </div>
      {questions.map((q, i) => (
        <fieldset key={i} className="qq" disabled={busy}>
          <legend className="qq-l">
            {q.header && <span className="qq-hd">{q.header}</span>}
            <span className="qq-q">{q.question}</span>
          </legend>
          {q.multiSelect && <p className="qq-n">여럿 고를 수 있어요</p>}
          <div className="qo-list">
            {q.options.map(o => (
              <label key={o.label} className="qo">
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={`${name}-${i}`}
                  checked={chosen[i]?.includes(o.label) ?? false}
                  onChange={() => pick(i, o.label, q.multiSelect)}
                />
                <span className="qo-tx">
                  <span className="qo-t">{o.label}</span>
                  {o.description && <span className="qo-d">{o.description}</span>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="ab">
        <button type="button" className="btn pri sm" disabled={!complete || busy} onClick={send}>
          답 보내기
        </button>
        <button type="button" className="lk" disabled={busy} onClick={skip}>
          대답 안 함
        </button>
      </div>
      {error && (
        <p className="pin-err" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
