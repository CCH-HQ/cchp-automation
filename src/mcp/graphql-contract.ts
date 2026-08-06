import {
  Kind,
  parse,
  stripIgnoredCharacters,
  valueFromASTUntyped,
  visit,
  type DocumentNode,
  type FieldNode,
  type OperationDefinitionNode,
} from "graphql"

export const ROADMAP_STATUS_OPTIONS = [
  { name: "评估中", color: "GRAY", description: "待完成:评估可行性与优先级,欢迎反馈", carry: ["Todo", "研究是否要做"] },
  { name: "规划中", color: "BLUE", description: "待完成:已确认纳入,设计实施方案", carry: ["决定如何做"] },
  { name: "暂不考虑", color: "RED", description: "待完成:经评估暂不纳入", carry: ["已决定不做"] },
  { name: "开发中", color: "YELLOW", description: "正在实现", carry: ["In Progress", "正在进行"] },
  { name: "已完成", color: "GREEN", description: "已合并 / 已发布", carry: ["Done"] },
] as const

export const ROADMAP_PROJECT_DESCRIPTION = "CCHP 对外产品路线图(由 cchp-automation 自动维护)"
export const ROADMAP_PROJECT_README = `# CCHP 产品路线图

CCHP(Claude Code Hub Plus)对外公开的功能路线图,按阶段分列:

| 列 | 含义 |
|---|---|
| 评估中 | 待完成:评估可行性与优先级,欢迎反馈 |
| 规划中 | 待完成:已确认纳入,正在设计方案 |
| 暂不考虑 | 待完成:经评估暂不纳入 |
| 开发中 | 正在实现 |
| 已完成 | 已合并 / 已发布 |

条目的 Milestone 即目标版本,表示计划随该版本发布。本看板由 cchp-automation
自动维护:开发动态实时同步,并每天与全部开发进度核对两次。`

export const ROADMAP_ADD_ITEM = `mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`
export const ROADMAP_MOVE_ITEM = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`
export const ROADMAP_ARCHIVE_ITEM = `mutation($p:ID!,$i:ID!){archiveProjectV2Item(input:{projectId:$p,itemId:$i}){item{id}}}`
export const ROADMAP_DISCOVERY_QUERY = `query($owner:String!,$number:Int!,$cursor:String){
  organization(login:$owner){projectV2(number:$number){
    id title shortDescription readme
    fields(first:100){nodes{
      ... on ProjectV2Field{id name}
      ... on ProjectV2SingleSelectField{id name options{id name color description}}
    }}
    items(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{id type
        fieldValues(first:50){nodes{... on ProjectV2ItemFieldSingleSelectValue{field{... on ProjectV2SingleSelectField{id name}} optionId name}}}
        content{
          __typename
          ... on Issue{id number title state stateReason repository{nameWithOwner} labels(first:50){nodes{name}} assignees(first:20){nodes{login}} milestone{number title state}}
          ... on PullRequest{id number title state isDraft merged repository{nameWithOwner} closingIssuesReferences(first:50){nodes{id number repository{nameWithOwner}}}}
        }
      }
    }
  }}
}`
export const ROADMAP_CREATE_STATUS_FIELD = `mutation($p:ID!,$opts:[ProjectV2SingleSelectFieldOptionInput!]!){
  createProjectV2Field(input:{projectId:$p,dataType:SINGLE_SELECT,name:"Status",singleSelectOptions:$opts}){
    projectV2Field{... on ProjectV2SingleSelectField{id name options{id name color description}}}
  }
}`
export const ROADMAP_UPDATE_STATUS_FIELD = `mutation($f:ID!,$opts:[ProjectV2SingleSelectFieldOptionInput!]!){
  updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:$opts}){
    projectV2Field{... on ProjectV2SingleSelectField{id name options{id name color description}}}
  }
}`
export const ROADMAP_UPDATE_PROJECT = `mutation($p:ID!,$description:String!,$readme:String!){
  updateProjectV2(input:{projectId:$p,shortDescription:$description,readme:$readme}){projectV2{id shortDescription readme}}
}`

export const MINIMIZE_COMMENT = `mutation($id:ID!,$classifier:ReportedContentClassifiers!){
  minimizeComment(input:{subjectId:$id,classifier:$classifier}){minimizedComment{isMinimized minimizedReason}}
}`

export const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{id isResolved isOutdated path line startLine
        comments(first:50){nodes{databaseId author{login} body createdAt}}}}}}}`
export const RESOLVE_THREAD_MUTATION = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`

export const DISCUSSION_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){discussion(number:$number){
    id number title
    comments(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{id author{login} body createdAt}}}}}`
export const DISCUSSION_ADD_COMMENT = `mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{id}}}`
export const DISCUSSION_UPDATE_COMMENT = `mutation($id:ID!,$body:String!){updateDiscussionComment(input:{commentId:$id,body:$body}){comment{id}}}`

export function canonicalGraphql(source: string): string {
  return stripIgnoredCharacters(source)
}

export function parseSingleOperation(source: string): { document: DocumentNode; operation: OperationDefinitionNode } {
  const document = parse(source)
  const operations = document.definitions.filter((definition): definition is OperationDefinitionNode =>
    definition.kind === Kind.OPERATION_DEFINITION,
  )
  if (operations.length !== 1 || document.definitions.length !== 1) {
    throw new Error("GraphQL broker accepts exactly one operation and no fragments")
  }
  return { document, operation: operations[0]! }
}

export function argumentValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const argument = field.arguments?.find((candidate) => candidate.name.value === name)
  return argument ? valueFromASTUntyped(argument.value, variables) : undefined
}

export function rootFields(operation: OperationDefinitionNode): FieldNode[] {
  const fields: FieldNode[] = []
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) throw new Error("GraphQL broker does not allow root fragments")
    fields.push(selection)
  }
  return fields
}

export function allFields(document: DocumentNode): FieldNode[] {
  const fields: FieldNode[] = []
  visit(document, { Field: (node) => { fields.push(node) } })
  return fields
}
