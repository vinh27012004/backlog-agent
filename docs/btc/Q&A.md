# Q&A với BTC Master the Machine 2026

Các câu hỏi đáp với BTC, gom theo chủ đề. Số `#n` là số thứ tự gốc trong bảng Q&A. Câu hỏi và câu trả lời giữ nguyên lời gốc, chỉ sửa khoảng trắng.

## Tóm tắt nhanh

- **Luật chơi:** hệ thống chạy hoàn toàn tự động, không có người can thiệp, và phải chạy bằng Codex CLI (#12). Mỗi trận có khoảng 10 item, có item có deadline (quá hạn thì server không nhận), có item không (#18). PI phải sửa càng nhanh càng tốt, nộp sau đội khác thì bị trừ điểm (#19). Item được gán sẵn type (#21). Bug đã sửa từ trước thì báo là đã sửa, nhưng item thường đòi bằng chứng như ảnh chụp trước và sau (#20).
- **Codebase:** không biết trước tech stack, mỗi vòng một repo khác nhau, mọi đội dùng chung một codebase, không được đổi stack hay viết lại (#1, #2, #16).
- **BTC cung cấp:** Codex Plugin (xác thực đội, spawn Orchestrator Agent, theo dõi chi phí token), URL + API key + team ID của Game Master Server, repo trên GitHub. Server mở ngày 26/10, Training Camp từ 26/10 đến 6/11 (#3–#7, #10).
- **Tài khoản AI:** thi đấu bằng Codex; xây agent bằng AI nào cũng được. Tài khoản 50$ của BTC không nạp thêm được, hết thì đổi sang tài khoản khác mà không bị phạt (#11, #13, #14, #17).
- **Hạ tầng:** mỗi đội 1 thiết bị và 1 tài khoản Game Master khi thi, không giới hạn số agent; khi trận bắt đầu không ai được chạm vào máy (#15).

## Luật chơi

### #12. Hệ thống phải tự chạy hay được prompt tay (HIL)?

**Hỏi:** Do I understand it correctly? We need to build something based on Codex CLI that runs by itself or we can actively prompt (HIL)?

**Đáp:** You need to build Agents - and even better: Agentic AI System - that can automatically: read Product Backlog from Game Master's website and do the task (implement the backlog items).

No human intervention while the system is running and doing the tasks.

Codex CLI is the runtime for such system mentioned above. It does not mean that you have to use Codex to build such system (you can use Claude to create Agents' instructions for example). Just be sure that such system needs to be executed with Codex CLI.

### #18. Deadline của từng backlog item

**Hỏi:** Dạ em muốn xác nhận một chút: hiện tại tổng thời gian của phần thi là 40 phút, vậy mỗi backlog item có được quy định thời gian thực hiện riêng không ví dụ deadline của 1 item 10 phút nhưng agent nó submit trễ hơn 10 phút thì sẽ không tính điểm item đó, hay team được tự phân bổ 40 phút cho các backlog item theo cách phù hợp?

**Đáp:** Trong backlog có khoảng 10 backlog item.
Trong số các backlog item này, có item có deadline, và có item không có deadline.
Item nào có deadline thì đội chơi phải submit trước deadline đó. Quá deadline mà submit là Game Master server sẽ không nhận.
Item nào không có deadline thì đội chơi submit lúc nào trước khi kết thúc trận đấu cũng được, đôi khi submit lúc nào tùy vào chiến thuật của đội.

### #19. Production incident gấp đến mức nào?

**Hỏi:** When the production incident comes, how urgent it is, does the Game System expects that we have to fix it as soon as possible?

**Đáp:** Yes, Game system expects Production incident to be fixed as soon as possible. So there will be points deduction for teams which submit PI later than other team. Please refer to MTM_Game_Rules.html

### #21. Item có được gán sẵn type không?

**Hỏi:** issue sẽ đc đánh type sẵn bug hay cr gì đó hay mình tự đọc mô tả r điều tra để ra đc type nhỉ

**Đáp:** Issue sẽ được đánh sẵn type

### #20. Bug đã được sửa từ trước thì sao?

**Hỏi:** How will the bug system actually work given we might have TDD in place that might find the bugs even before judges point it out to the harness to fix? 🤔
Or we can just report that the bug was already fixed in that case?

**Đáp:** You can just report that the bug was already fixed. But, usually the backlog item will request some evidences. One of the evidence could be the application's screenshot before fixing and then 1 application's screenshot after the bug is fixed.

## Codebase

### #1. Có biết trước tech stack không?

**Hỏi:** source code BTC cung cấp là có cho biết trước loại tech stack nào trước ko a

**Đáp:** Không bạn ạ. Thông tin đó chỉ có lúc publish đề của trận đấu thôi. Mà các vòng khác nhau có thể thi trên các bộ source khác nhau với tech stack khác nhau nhé, ko nói trước được

### #2. Có được đổi tech stack không? Codebase có theo stack của từng đội không?

**Hỏi:**

1. Speaking about the codebase, what is the tech stack of this? Can we remake the code stack or we have to stay to what we are given? I am asking because the current Fsoft favorite JAVA + Angular are probably the absolute worst tech stacks for token savings
2. BTC cho mình hỏi thêm thông tin về việc làm tasks của từng team. BTC có dựa trên ngôn ngữ (C/C++, Python, Java, ...), framework, tech stack, ... của từng team để cung cấp code base phù hợp hay không vậy

**Đáp:** Hi everyone,

We, the organizers, will act as an FPT Software customer and provide you with an existing product source codebase that is already running in the market.

Your job is to take over and maintain the product. You are not allowed to change its tech stack or rebuild the product from scratch. This is also quite close to what we often deal with in our day-to-day work.

Legacy migration, meaning moving an existing system to a newer and more modern tech stack, is becoming increasingly popular in the era of AI-driven software development. However, that is not the scenario of this competition.

The source codebase provided for each match will not be overly complex. It will not use any rare or obscure tech stacks, and it will not be too large either. So don't worry, the organizer of this game have no purpose of burning your AI tokens 😄. But since this is a game, we'll make things a little tricky here and there to keep it fun.

Think of it as both a competition and a game: a chance to exchange knowledge, having fun is the most important point, and, of course, winning some prizes is also the most important point! (vui là chính, giải là chủ yếu)

The same source codebase will be used by all teams. We will not create matches based on the tech stacks that each team is already familiar with. Teams will need to adapt to the requirements of each match.

### #16. Một repo cho cả giải hay mỗi vòng một repo?

**Hỏi:** Ban tổ chức cho em hỏi mình sẽ làm việc với 1 repo do ban tổ chức cung cấp từ đầu đến cuối hay là mỗi vòng sẽ là 1 repo ạ

**Đáp:** Nếu bạn đang nói về repo chứa source base cho hệ thống mà đội chơi sẽ cần sửa và làm task trên đó thì mỗi vòng chơi là một repo / source base khác nhau nhé.

## BTC cung cấp gì

### #3. Công cụ BTC cung cấp

**Hỏi:** Công cụ do BTC cung cấp là những công cụ gì thế ạ?

**Đáp:** Nó là 1 tool - tạm gọi là Codex Plugin đi cho dễ hình dung. Nó tích hợp sâu vào Codex SDK. Nó sẽ:

- Xác thực đội chơi và liên kết với Game Master Server để đăng ký đội chơi.
- Xác thực ok --> nó sẽ spawn Orchestrator Agent của đội chơi ra để Orchestrator chạy và làm việc.
- Nó monitor, tracking được output của Orchestrator agent, biết đội chơi tốn chi phí token thế nào, v..v..

### #4. Thông tin Game Master Server

**Hỏi:** Game master server thì các a sẽ cung cấp những gì? Url endpoint, api key, team id đúng không?

**Đáp:** Đúng rồi

### #10. Tài liệu API để kết nối và lấy task

**Hỏi:** Đoạn kết nối rồi tự động lấy task chắc nhờ BTC cung cấp sớm info để các đội implement đúng không ạ?

**Đáp:** Đúng rồi, chờ Training Camp bạn nhé.

### #7. Repo git nằm ở đâu?

**Hỏi:** Các repos git các anh cung cấp nó là loại github

**Đáp:** Github nhé.

### #5. Khi nào server mở?

**Hỏi:** Server thì khi nào sẽ được mở?

**Đáp:** Khi bước vào Training Camp - cụ thể là ngày 26/10 - server sẽ được mở

### #6. Có được test trước không?

**Hỏi:** Có cần mở để test trước không?

**Đáp:** Training Camp 2 tuần từ 26/10 đến 6/11 chính là thời gian để các đội chơi phát triển Agents, test connection với Game Master Server, và đấu thử với nhau (Trial rounds).

## Tài khoản AI

### #11. Có được dùng AI hoặc key cá nhân không?

**Hỏi:** cho tôi hỏi là mình chỉ được dung AI ban tổ chức hay dung đc AI cá nhân, key riêng đc ko ?

**Đáp:** Về AI Provider:

- Để thi đấu: Các bạn cần sử dụng Codex.
- Để tạo Agents / Agentic system (nếu các bạn dùng AI): có thể dùng AI Provider nào cũng được, tùy các bạn (Claude, GitHub Copilot, v..v..), miễn là các bạn có AI License hợp pháp :D.

Về AI License:

- 60 đội đầu tiên được cấp 1 account Codex Enterprise của công ty - 50$. Các bạn có thể sử dụng AI License khác, nhưng cần theo đúng rule BMTT của công ty.

### #13. Hết 50$ giữa trận thì sao?

**Hỏi:** What happens when we reach the 50$ cap of token usage, agent dies, or we spend more and get penalties?

**Đáp:** If during a match, the token reaches $50 cap of usage and agents stop working, the team can use their PC to switch account (if they want). In such situation (just switching account only), the team will not get penalty. I will update this point to the game rules document. Thanks.

### #14. Mỗi đội có mấy tài khoản?

**Hỏi:** Follow up for 2:

- 2.1: We can switch accounts? Sorry I thought we had 1 account per team?
- 2.2 does each team get multiple accounts?

**Đáp:** Organizers will provide 1 Codex account (50$) as a sponsor for the first 60 teams.
But it does not mean that you have to use that single account through out the game. You can use other accounts if you have.

### #17. Có nạp thêm tiền vào tài khoản BTC được không?

**Hỏi:** We are talking about Open AI (FPT) enterprise license only right? meaning if we run out of 50$ we need top up with our BU. you said Switch account that doesn't mean we switch to any personal account right?

**Đáp:** The account provided by "Master The Machine" Organizer will not be able to top-up, even with BU budget. So, you need to switch account. You can either use another BU account or your personal account. Note: Information Security rule of Fsoft requires that you can only use personal account in your personal PC.

## Hạ tầng của đội

### #15. Được dùng mấy máy khi thi?

**Hỏi:**

> Theo như câu trả lời này thì mình đang hiểu là mỗi đội chỉ được giới hạn sử dụng 1 thiết bị (laptop) để thi đấu có đúng không ? Ví dụ như mình dùng 2-3 laptop và dựng 1 hệ thống để cả 2-3 laptop cùng làm việc thì có được không
>
> team 5 người chả nhẽ 4 người đứng chơi

**Đáp:** Trước hết: khi trận đấu start là tất cả thành viên đội chơi ko được thao tác vào máy tính nhé. Nên thực tế là 5 người đứng chơi không chứ ko phải 1 người làm, 4 người đứng chơi đâu ạ.
Còn trước khi trận đấu start thì các bạn có 3 đến 5 người cùng phối hợp với nhau để tạo ra agents cho việc thi đấu. Quan trọng là phần chuẩn bị trước này.

Khi thi đấu, đúng là đội chơi sẽ chỉ được giới hạn sử dụng 1 thiết bị để thi đấu. Mỗi đội cũng chỉ được cấp 1 tài khoản duy nhất để kết nối vào Game Master server thôi. Còn BTC không giới hạn số Agents các bạn dùng

### #9. Có được dùng công cụ bên thứ ba ngoài Codex CLI?

**Hỏi:** Ngoài codex cli có được dùng các 3rd khác không? Vd database, VS code, ....

**Đáp:** Được, miễn là bạn đảm bảo rule BMTT trên thiết bị công ty cấp (nếu dùng máy công ty). Nếu dùng máy cá nhân thì bạn đảm bảo lương tâm và chịu mọi trách nhiệm liên quan đến bản quyền, BTC không chặn việc sử dụng tool / lib khác, nhưng việc dùng nó có hợp pháp hay không thì các bạn phải tự đảm bảo.

### #8. Mạng công ty có vào được repo không?

**Hỏi:** máy công ty dùng mạng cty hay mạng ngoài có vào được không? Cần phải test trước repos và account xem có vào được git repos các a cung cấp

**Đáp:** Sẽ test trong giai đoạn Training Camp nhé.
