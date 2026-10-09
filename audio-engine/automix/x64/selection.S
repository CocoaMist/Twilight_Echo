/* Win64 handwritten selection: stable bottom-up merge, checked integer fold,
 * default strategy routing and weighted pick. Caller validates finite scores. */
.intel_syntax noprefix
.text
.globl am_k_stable_sort
.seh_proc am_k_stable_sort
am_k_stable_sort:
 push rbx
 .seh_pushreg rbx
 push rbp
 .seh_pushreg rbp
 push rsi
 .seh_pushreg rsi
 push rdi
 .seh_pushreg rdi
 push r12
 .seh_pushreg r12
 push r13
 .seh_pushreg r13
 push r14
 .seh_pushreg r14
 push r15
 .seh_pushreg r15
 .seh_endprologue
 mov rbx,rcx
 mov rsi,rcx
 mov rdi,rdx
 mov rbp,r8
 mov r10,1
.Lsort_pass:
 cmp r10,rbp
 jae .Lsort_done
 xor r12d,r12d
.Lsort_run:
 cmp r12,rbp
 jae .Lsort_swap
 mov r13,r12
 lea r14,[r12+r10]
 cmp r14,rbp
 cmova r14,rbp
 mov r15,r14
 lea r11,[r14+r10]
 cmp r11,rbp
 cmova r11,rbp
.Lsort_merge:
 cmp r12,r11
 jae .Lsort_run
 cmp r13,r14
 jae .Lsort_right
 cmp r15,r11
 jae .Lsort_left
 lea rax,[r13+r13*2]
 lea rcx,[rsi+rax*8]
 lea rax,[r15+r15*2]
 lea rdx,[rsi+rax*8]
 movsd xmm0,QWORD PTR [rcx+8]
 ucomisd xmm0,QWORD PTR [rdx+8]
 ja .Lsort_left
 jb .Lsort_right
 mov rax,QWORD PTR [rcx+16]
 cmp rax,QWORD PTR [rdx+16]
 jl .Lsort_left
 jg .Lsort_right
 mov rax,QWORD PTR [rcx]
 cmp rax,QWORD PTR [rdx]
 jbe .Lsort_left
.Lsort_right:
 lea rax,[r15+r15*2]
 inc r15
 jmp .Lsort_copy
.Lsort_left:
 lea rax,[r13+r13*2]
 inc r13
.Lsort_copy:
 lea rcx,[rsi+rax*8]
 lea rax,[r12+r12*2]
 lea rdx,[rdi+rax*8]
 movups xmm0,XMMWORD PTR [rcx]
 movups XMMWORD PTR [rdx],xmm0
 mov rax,QWORD PTR [rcx+16]
 mov QWORD PTR [rdx+16],rax
 inc r12
 jmp .Lsort_merge
.Lsort_swap:
 xchg rsi,rdi
 shl r10,1
 jmp .Lsort_pass
.Lsort_done:
 cmp rsi,rbx
 je .Lsort_return
 xor r9d,r9d
.Lsort_copy_back:
 cmp r9,rbp
 jae .Lsort_return
 lea rax,[r9+r9*2]
 movups xmm0,XMMWORD PTR [rsi+rax*8]
 movups XMMWORD PTR [rbx+rax*8],xmm0
 mov rdx,QWORD PTR [rsi+rax*8+16]
 mov QWORD PTR [rbx+rax*8+16],rdx
 inc r9
 jmp .Lsort_copy_back
.Lsort_return:
 pop r15
 pop r14
 pop r13
 pop r12
 pop rdi
 pop rsi
 pop rbp
 pop rbx
 ret
.seh_endproc

.globl am_k_add_weight
.seh_proc am_k_add_weight
am_k_add_weight:
 .seh_endprologue
 add rcx,rdx
 jo .Ladd_overflow
 mov QWORD PTR [r8],rcx
 xor eax,eax
 ret
.Ladd_overflow:
 mov eax,2
 ret
.seh_endproc

.globl am_k_weighted_pick
.seh_proc am_k_weighted_pick
am_k_weighted_pick:
 .seh_endprologue
 xor eax,eax
 xor r9d,r9d
.Lpick_loop:
 cmp rax,rdx
 jae .Lpick_none
 add r9,QWORD PTR [rcx+rax*8]
 cmp r8,r9
 jb .Lpick_return
 inc rax
 jmp .Lpick_loop
.Lpick_none:
 mov rax,-1
.Lpick_return:
 ret
.seh_endproc

.globl am_k_route
.seh_proc am_k_route
am_k_route:
 .seh_endprologue
 mov QWORD PTR [rdx],rcx
 mov DWORD PTR [rdx+8],0
 mov DWORD PTR [rdx+12],-1
 mov DWORD PTR [rdx+16],-1
 mov DWORD PTR [rdx+20],-1
 mov QWORD PTR [rdx+24],0
 lea r8,[rip+.Lcatalogue]
 mov r9d,24
.Lroute_member:
 cmp rcx,QWORD PTR [r8]
 je .Lroute_yes
 add r8,8
 dec r9d
 jnz .Lroute_member
 ret
.Lroute_yes:
 mov BYTE PTR [rdx+8],1
 lea r8,[rip+.Lroutes]
 mov r9d,16
.Lroute_find:
 cmp rcx,QWORD PTR [r8]
 je .Lroute_found
 add r8,32
 dec r9d
 jnz .Lroute_find
 ret
.Lroute_found:
 movups xmm0,XMMWORD PTR [r8]
 movups xmm1,XMMWORD PTR [r8+16]
 movups XMMWORD PTR [rdx],xmm0
 movups XMMWORD PTR [rdx+16],xmm1
 ret
.seh_endproc
.section .rdata,"dr"
.p2align 3
.Lcatalogue:
 .quad 0,1,2,3,33,4,44,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,22
.macro route id,algo,complexity,path,base
 .quad \id
 .byte 1,1,0,0
 .long \algo,\complexity,\path
 .double \base
.endm
.Lroutes:
 route 17,0,3,1,17
 route 19,0,3,0,17
 route 15,1,3,5,100
 route 18,1,3,4,100
 route 16,2,3,6,50
 route 20,2,3,6,50
 route 8,3,3,2,20
 route 9,3,3,2,50
 route 12,3,3,3,20
 route 3,4,2,7,10
 route 33,4,2,7,10
 route 4,4,2,7,10
 route 44,4,2,7,10
 route 0,5,1,8,1
 route 5,6,2,10,10
 route 1,7,0,9,1
