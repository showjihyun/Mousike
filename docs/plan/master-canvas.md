# Master 캔버스 설계서

> **작성**: 2026-05-21
> **상태**: Draft v0.1 (groundwork only — UI 코드는 Month 4+ 까지 미작성)
> **연계 문서**: `docs/plan/acestep-ui-design-plan.md` (Master mode 가 본 문서 범위), `docs/adr/0002-song-derivation-on-songs-table.md` (스키마 결정)
> **레퍼런스**: ComfyUI (node-graph editor), ACE-Step Gradio UI

---

## 0. 핵심 요약

**한 줄 정의**: Master 캔버스는 사용자가 만들어 온 곡들의 파생 관계를 ComfyUI 스타일의 directed graph 로 시각화한, Master mode 의 주 작업 표면이다.

**범위**:
- 본 문서는 **Master mode 만** 다룬다. Spark/Play 의 기존 디자인은 그대로 유지된다.
- ComfyUI 와 ACE-Step Gradio 는 **참조용**이다. 핵심 사용자(전체의 10%) 대상의 Master mode 한정 — 일반 사용자가 보는 화면은 바뀌지 않는다.

**무엇이 아닌가**:
- ComfyUI 식의 declarative pipeline editor 가 아니다. 사용자는 그래프를 미리 그려놓고 한 번에 실행하지 않는다.
- 새로운 데이터 모델(workflow entity) 이 아니다. 곡(Song) 과 파생(derivation) 두 개념만 쓴다.
- /library 의 교체가 아니다. 별도 표면(/master 라우트 또는 토글)로 추가된다.

---

## 1. 6가지 결정 요약

본 문서는 `/grill-with-docs` 세션(2026-05-21)에서 합의된 6가지 결정을 기록한다. CONTEXT.md 에 추가된 용어들(Master canvas / Song node / Derivation / Derivation edge)이 본 문서 전반에서 쓰인다.

| # | 결정 | 대안 (기각됨) |
|---|---|---|
| Q1 | 범위: **Master mode 한정** | (A) 전면 피벗 / (C) 시각 톤만 / (D) 단일 기능만 |
| Q2 | 참조 측면: **ComfyUI node-graph 메타포** | (B) ACE-Step Gradio 밀도 / (C) 둘 다 / (D) 미관만 |
| Q3 | 노드 의미: **하이브리드 — 노드=Song, 엣지에 op 라벨** | (1) 노드=Song만 / (2) 노드=Operation (true ComfyUI) |
| Q4 | 상호작용 모델: **Incremental — 그래프는 세션 히스토리** | (B) Declarative / (C) Hybrid w/ 저장된 workflow |
| Q5 | 스키마: **`songs.parent_song_id` + `songs.derivation_kind`** | (b) jobs.payload 에서 재구성 / (c) 별도 derivations 테이블 |
| Q6 | 단계: **Groundwork 지금, UI 는 Month 4+** | (2) 병렬 출시 / (3) /library 대체 / (4) 보류 |

---

## 2. 사용자 시나리오

> **시나리오 A — 곡 진화 추적**
>
> 사용자가 곡 A 를 생성했다. 마음에 들지만 후렴(0:45–1:15)이 약하다고 느껴 repaint 로 A' 을 만들었다. A' 의 베이스가 빈약해서 lego 로 베이스를 추가한 A'' 을 만들었다. /master 에 들어가면 캔버스에 세 개의 Song node 가 보인다:
>
> - **A** (seed) → 파생 엣지 라벨 `repaint 0:45–1:15` → **A'** → 파생 엣지 라벨 `lego +bass` → **A''**
>
> 사용자는 캔버스에서 곡명을 클릭해 즉시 재생할 수 있고, 어느 노드에서든 새로운 파생을 추가할 수 있다.

> **시나리오 B — 분기 탐색**
>
> A' 에서 또 다른 방향을 시도하려면 A' 에서 새로운 repaint(다른 구간) 를 호출한다. 결과 곡 B 는 A' 의 자식이 되어 캔버스에 분기로 나타난다. 사용자는 두 갈래(A'' 와 B)를 들어보고 비교한다.

> **시나리오 C — 큰 라이브러리**
>
> 사용자가 200곡 가까이 만들었다. 캔버스 전체를 다 보여주면 압도된다. (열린 질문 — §5 참고: 줌, 필터, 검색 중 무엇으로 풀지)

---

## 3. 데이터 모델

ADR-0002 의 결정에 따라 `songs` 테이블에 두 컬럼이 추가된다.

```sql
-- 008_song_derivation.sql (마이그레이션 파일 참고)
alter table songs
  add column parent_song_id   text references songs(id) on delete cascade,
  add column derivation_kind  text;

alter table songs
  add constraint songs_derivation_paired
    check ((parent_song_id is null) = (derivation_kind is null));

create index songs_parent_idx
  on songs (parent_song_id)
  where parent_song_id is not null;
```

**불변식**:
- Seed Song (텍스트 프롬프트로 처음 만든 곡): `parent_song_id = NULL` AND `derivation_kind = NULL`
- Derived Song (repaint/lego/cover/... 의 결과): 두 컬럼 모두 NOT NULL
- 두 컬럼이 짝으로 같이 채워지거나 같이 NULL 이라는 점이 `CHECK` 로 강제된다.

**Worker 책임**:
`server/jobs.ts` 의 결과 처리 단계에서 derived job (kind ∈ {`repaint`, `lego`, 그리고 향후 `cover`/`extract`/`complete`}) 의 결과 Song 행을 insert 할 때 두 컬럼을 채운다. `generate` 잡은 두 컬럼을 NULL 로 둔다.

**legacy 데이터**:
마이그레이션 이전에 존재하던 모든 곡은 두 컬럼이 NULL — Master 캔버스에서는 seed 로 표시된다. 예전 repaint/lego 결과들은 표면적으로 parent 가 없는 것처럼 보이지만, 이는 의도된 손실이다 (jobs 테이블에서 사후 백필을 시도하면 ROI 가 낮음).

**그래프 렌더링 쿼리**:

```sql
-- 한 유저의 전체 그래프
select id, parent_song_id, derivation_kind, title, audio_url, created_at
  from songs
 where user_id = $1
 order by created_at asc;
```

이 쿼리 한 번으로 클라이언트는 그래프를 그릴 수 있다. 추가 조인 없음.

---

## 4. UI 컨셉 (Month 4+ 상세 설계 전 스케치)

본 절은 **참조용 스케치**이다. 실제 UI 코드는 Month 4 까지 작성되지 않는다.

### 4.1 캔버스 레이아웃

```
┌──────────────────────────────────────────────────────┐
│ ← 일반 모드  Master 캔버스           [저장] [공유]   │
├──────────────────────────────────────────────────────┤
│                                                       │
│    🌱 seed A         🌱 seed B                       │
│       │                  │                            │
│       │ repaint           │ cover                     │
│       │ 0:45–1:15         │ K-pop                     │
│       ▼                  ▼                            │
│    ▶ A'              ▶ B'                            │
│       │                                                │
│       │ lego                                          │
│       │ +bass                                          │
│       ▼                                                │
│    ▶ A''                                              │
│                                                        │
│  [+ 새 곡 만들기]    [줌] [중앙으로]                 │
└──────────────────────────────────────────────────────┘
```

### 4.2 Song node 디자인

각 노드는 ComfyUI 식 카드형 블록.

- **상단**: 곡 제목 + 재생 버튼
- **중앙**: 파형 미니맵 (Play mode 카드와 동일 컴포넌트 재사용)
- **하단**: 메타데이터 칩 (BPM · Key · Duration · Vocal language)
- **포트**: 출력 포트 1개 (캔버스 우측). 입력 포트는 없음 — 노드는 직접 연결되지 않고 파생 액션으로만 자식이 만들어진다.

### 4.3 Derivation edge 디자인

- 부모 → 자식 방향의 곡선 (ComfyUI 의 베지에 와이어 스타일).
- 엣지 중앙에 라벨 박스: `repaint 0:45–1:15`, `lego +bass`, `cover K-pop`, 등.
- 엣지 색상은 derivation_kind 별로 구분 (예: repaint=주황, lego=초록, cover=보라).

### 4.4 ComfyUI 와의 차이점 (의도된 것)

| | ComfyUI | Master 캔버스 |
|---|---|---|
| 노드의 의미 | Operation (변환기) | Song (결과물) |
| 실행 시점 | 그래프 전체 한번에 (declarative) | 한 노드씩 추가될 때 (incremental) |
| 와이어 의미 | 데이터 흐름 (audio/latent/conditioning) | 부모-자식 derivation |
| 저장되는 것 | Workflow JSON (재실행 가능한 파이프라인) | Song history (이미 생성된 결과들) |
| 사용자 액션 | 노드 추가/연결/실행 | 기존 노드 선택 → op 선택 → 결과 노드 자동 생성 |

---

## 5. 의도적으로 미해결로 남긴 질문

본 세션에서 합의에 이르지 못한 / Month 4 구현 시 결정할 항목들.

1. **캔버스 줌/팬/네비게이션**: 200개 노드 시나리오를 줌 + 미니맵 + 검색 중 무엇으로 풀지.
2. **자동 레이아웃 vs 사용자 배치**: dagre 같은 자동 알고리즘으로 노드를 배치할지, 사용자가 자유 배치하고 위치를 저장할지.
3. **모바일 지원**: Master 캔버스가 모바일 우선인지, 데스크탑 한정인지. (90% 사용자가 모바일이라는 본 서비스의 일반론은 *Spark/Play* 가정. Master 모드는 PC 비중이 더 높을 수 있다.)
4. **시각 톤**: 다크 테마 기본, ComfyUI 식 그리드 배경, 와이어 색감 등의 구체적 톤. 아직 결정하지 않음.
5. **`cover`/`extract`/`complete` 잡 도입 시점**: 이 op 들이 ACE-Step 백엔드에서 작동하는지 / 별도 시도 필요한지. Week 1 PoC 액션 (Q3-Q5 of plan).
6. **공유**: 그래프 전체 또는 일부 분기를 다른 사용자와 공유할 수 있는지. ([acestep-ui-design-plan.md §3.2 의 "공유 시 진화 트리를 자랑할 수 있음 → 바이럴" 언급]을 어떻게 구현할지)

---

## 6. 즉시 액션 (groundwork 단계)

1. **마이그레이션 007 머지**: `server/migrations/008_song_derivation.sql` — `parent_song_id` + `derivation_kind` 컬럼 추가.
2. **Worker 변경 (선택, Month 2 에 같이)**: `server/jobs.ts` 에서 repaint/lego 결과 Song 행을 insert 할 때 두 컬럼을 채움. — 이는 Play mode 의 "← 부모곡" 표시(`acestep-ui-design-plan.md` §C.3 Month 2) 에도 필요하므로 Master 와 무관하게 ROI 있음.
3. **본 문서 + ADR-0002 머지**.
4. **Master UI 코드는 미작성**. Month 4+ 시작 시 본 문서를 재방문.
