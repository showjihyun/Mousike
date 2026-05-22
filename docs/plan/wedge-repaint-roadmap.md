# Wedge: 한국어 구간 재생성 — 6주 액션 플랜

> **작성**: 2026-05-22
> **상태**: Draft v0.1
> **연계 문서**: `docs/plan/acestep-ui-design-plan.md` (전체 UI 전략), `docs/plan/master-canvas.md` (Master 모드)
> **포지셔닝**: "Suno로 만든 곡을 한국어로 부분만 다시 만지는 가장 매끄러운 서비스"

---

## 0. 한 줄 진입점

> 국내 토종은 "프로용", 해외 빅3는 "보컬 자판기". **"한국어로 놀이처럼 구간을 다시 만지는"** 자리가 비어 있다. Mousike의 `repaint`·`lego`·Toss 결제 조합이 그 자리에 가장 가까운 무기.

이 6주 플랜은 그 무기를 외부 사용자가 **찾고 → 써보고 → 결제하는** 깔때기로 만드는 작업.

---

## 1. 6주 후 성공 정의 (KPI)

| # | 지표 | 목표 |
|---|------|------|
| K1 | 외부 유입 (랜딩 방문) | 100명+ |
| K2 | 외부 음원 업로드 → repaint 완료 전환율 | 30%+ |
| K3 | Pro/Starter 결제 전환 | 5명+ |
| K4 | SNS(인스타 릴스 등) 조회 누적 | 10,000+ |

K2는 *깔때기의 핵심*. 100명이 들어와서 30명이 repaint 끝까지 가면 wedge가 작동한다는 신호. 5명 결제는 결제 흐름의 마찰을 검증.

---

## 2. 스프린트 구조 (2주 × 3)

### Sprint 1 (Week 1-2) — 외부 음원 업로드 → repaint 동선 구축

**Goal**: Suno/Udio에서 만든 mp3 를 업로드해서 Mousike 의 기존 `repaint`/`lego` 로 흘려보낼 수 있게.

**Deliverables**:
- [ ] 스토리지 결정: Supabase Storage vs 로컬 디스크. *(2시간 spec → ADR)*
- [ ] 업로드 엔드포인트 `POST /api/upload`: multipart/form-data, 50MB cap, mp3/wav만, ffprobe 로 길이 ≤4분 검증, 로그인 필수.
- [ ] `server/audio.ts`: 업로드된 파일 → ACE-Step `GradioSource` 변환 헬퍼.
- [ ] DB 마이그레이션 009: `songs.source text check (source in ('internal','external'))`. NULL=internal (legacy).
- [ ] FE: 홈 페이지에 "Suno 곡 가져오기" 카드 추가 (드래그 앤 드롭). 비로그인은 로그인 게이트로.
- [ ] FE: 업로드 완료 → 곡 카드 자동 렌더 → 기존 `RepaintModal`/`LegoModal` 호출.
- [ ] 24시간 retention 정책: 원본 업로드 mp3 는 24h 후 삭제 (cron). 결과물(repaint 출력)은 유지.

**Effort**: ~30-35h (BE 18h + FE 12h + 결정/문서 5h)

**Risk**:
- 스토리지 비용 — Supabase Storage 무료 1GB → 50MB cap + 24h retention 으로 통제.
- 업로드 시 abuse 우려 — 로그인 필수 + IP 레이트리밋 + 길이 cap.

**Done when**: 비공개 테스트로 Suno에서 만든 30초 mp3 업로드 → repaint 모달 열림 → 새 곡 생성됨 → 결과 카드에 "원본곡" 라벨 표시.

---

### Sprint 2 (Week 3-4) — 랜딩 메시지 재정렬 + 모바일 정리

**Goal**: 외부 유입자가 5초 안에 "이거 내가 찾던 거다" 라고 느끼게.

**Deliverables**:
- [ ] `HomePage.tsx` 히어로 카피 재작성: 현 "한 줄로 시작하는 음악 놀이터" → **"Suno로 만든 곡, 한국어로 후렴만 바꿔드려요"** (또는 사용자 테스트 후 결정).
- [ ] 6개 quick-start preset → "업로드 후 할 수 있는 것" 6가지로 교체 — F6 동시 해결.
  - 예: "후렴 더 신나게 / 다른 스타일로 / 베이스 추가 / 보컬 빼기 / 30초 더 늘리기 / 분위기 비슷한 새 곡"
- [ ] 모바일 hamburger 메뉴 (F3): `Topbar.tsx` ≤760px 에서 햄버거 → drawer (내 라이브러리 / 업로드 / 고급).
- [ ] 가격 노출: 첫 화면 어딘가에 "월 9,900원 · Toss 결제" 작은 배지 + 클릭 시 UpgradeModal.
- [ ] `UpgradeModal`: "Suno 대비" 비교 행 1줄 추가 — 한국어 UI / Toss / 저작권 안전. **공격적 톤 금지, 보완재 톤 유지** ("만들었다면 → 다듬어드려요").
- [ ] Footer 컴포넌트 추가 (F23): 브랜드/회사/약관/문의.
- [ ] H2 헤딩 위계 정리 (F14).

**Effort**: ~25-30h (디자인 8h + FE 15h + 카피 5h)

**Risk**:
- 카피 톤. "Suno 까는 식" 이면 커뮤니티 반발. 보완재 (complement) 톤 — Suno로 만들고 → 우리로 다듬기.
- F3 햄버거 = 모바일 햄버거가 처음 도입되는 작업. 디자인 충돌 가능, Sprint 2 초반에 우선 처리.

**Done when**: 모바일 + PC 양쪽에서 비로그인 사용자가 첫 화면에서 (a) 메시지, (b) 가격, (c) 진입점 — 셋 다 5초 내 파악.

---

### Sprint 3 (Week 5-6) — 측정 + 외부 노출 + 첫 사용자

**Goal**: 깔때기가 실제로 작동하는지 데이터로 확인. 첫 100명 흘려보내기.

**Deliverables**:
- [ ] 분석 도입: Plausible (privacy-friendly, 한국 SaaS 친화) 또는 Posthog (이벤트 풀 트래킹). **Plausible 추천** — 솔로 운영 부담 적음.
- [ ] 이벤트 트래킹 인스트루멘테이션:
  - `landing_view`, `upload_start`, `upload_success`, `upload_failed`
  - `repaint_start`, `repaint_complete`, `lego_complete`
  - `share_click`, `upgrade_view`, `upgrade_paid`
- [ ] 인스타 릴스 5편 (편당 30-60초): "Suno 곡 → 후렴 바꾸기" 흐름. 화면 녹화 + 한국어 자막. 음원은 결과물 발췌.
- [ ] 한국 커뮤니티 소프트 런칭 — 3곳 선정:
  - 후보: 인스타 릴스 #AI음악, 디시 음악 갤러리, 클리앙 IT/음악, 22세기 음악, X(트위터) 한국어권 음악 봇 계정.
  - 톤: "Suno 쓰다가 후렴이 마음에 안 들 때 써봤어요" 사용자 후기 톤. 공식 홍보 톤 X.
- [ ] 첫 결제자에게 1문항 출처 추적: "어떻게 알게 됐어요?" Toss 결제 confirm 직후 모달.
- [ ] 에러 메시지 한국어 polish (F17 토스트 lifetime 포함).
- [ ] 큐 압박 테스트: 소프트 런칭이 갑자기 트래픽 만들면 ACE-Step 큐가 막힘. **Pro 사용자 우선순위 / 무료 일일 한도 강제**. (안 그러면 결제자가 줄서서 평판 손상.)

**Effort**: ~25-30h (분석 8h + 콘텐츠 12h + 폴리시/런칭 운영 8h)

**Risk**:
- 큐 막힘 — Pro 우선순위 도입 검토 필수 (Sprint 3 초반에 결정).
- 인스타 릴스 콘텐츠 제작 시간 + 영상 편집 스킬 — *솔로 캐파 압박 가장 큰 항목*. 컷한다면 릴스 3편 + 트위터 짧은 영상으로 축소.
- 첫 사용자가 부정적 후기 — 작은 베타 안내 (`(베타)` 라벨) 로 기대치 조정.

**Done when**: K1-K4 측정 가능 + 첫 5명 결제. 깔때기 어디에서 빠지는지 데이터로 보임.

---

## 3. 6주 후 분기 결정

| 시나리오 | 결정 |
|---------|------|
| K1-K4 모두 달성 | 같은 메시지로 광고비 소액 (월 30-50만원) 투입, Family Tree 출시 가속 |
| K2 (전환율) 낮음 | 업로드 → repaint 사이 마찰 진단 (포맷 안내? 길이 제한? UI?) |
| K1 (유입) 0 | 메시지가 잘못 — Suno 회피층이 아닌 다른 페르소나로 피벗 (영상 BGM 크리에이터, 1인 콘텐츠 제작자 등) |
| K3 (결제) 0이지만 K1/K2 OK | 가격이 문제 vs 무료 한도가 너무 후함 — 무료 30초→15초 축소 실험 |

---

## 4. 명시적으로 안 하는 것 (6주 내)

- **Family Tree 풀 시각화**: Gap 1 노리지만 미출시 무기. Sprint 3에서 텍스트 라벨("← 부모곡") 정도만, 풀 시각화는 6주+α.
- **LoRA "내 스타일"**: 후순위. 학습 비용/품질 리스크 큼.
- **cover/extract/complete 작업**: 이번 6주 안 함. Sprint 1 외부 업로드 + 기존 repaint·lego 만으로 wedge 충분.
- **영문 UI**: 한국어 wedge 검증이 먼저.
- **광고비 투입**: 6주 후 KPI 보고 결정.
- **Master 캔버스 UI**: `master-canvas.md` 의 그래프 뷰. Month 4+ 로 유지.

---

## 5. 의존성 + 리스크 한눈

| 항목 | 리스크 | 대응 |
|------|--------|-----|
| ACE-Step Docker 큐 | 트래픽 몰리면 막힘 → 평판 손상 | Sprint 3에 Pro 우선순위 + cloud GPU 비상 옵션(RunPod) 의사결정만 |
| Supabase Storage 비용 | 무료 1GB 초과 가능 | 50MB cap + 24h retention + 결과물만 영구 |
| Toss 결제 한도 | 첫 5명까지는 무리 없음 | 10명+ 도달 시 한도 상향 신청 |
| 솔로 개발자 캐파 | 주 18-20시간 가정 → 6주 110-120시간. 위 deliverable 합계 80-95h → 여유 25% | 부족하면 Sprint 1 의 lego 통합 컷 (repaint만으로도 wedge 작동) |
| 메시지 톤 | "Suno 까기" 로 비치면 역효과 | 보완재 톤, A/B 테스트 후 결정 |

---

## 6. 결정적 한 줄

> **6주 안에 K2(업로드 → repaint 완료 30%+)와 K3(결제 5명+) 둘 다 달성하면 wedge가 작동하는 것. 둘 중 하나라도 안 되면 메시지/제품 둘 중 하나에 문제 있는 것. K1만 되고 둘 다 안 되면 트래픽은 받는데 깔때기는 새는 상태 — 가장 어색하지만 가장 정보가 많은 결과.**
