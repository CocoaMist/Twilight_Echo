/* Handwritten Win64/SSE2. Evidence: score-core 0x227456e54, candidate-paths,
 * weighted-score-selection 0x227476a9c, uniform-range-selection 0x227477c04.
 * No FMA: multiplying factors and adding the signed endpoint preference are separate. */
.intel_syntax noprefix
.text
.globl am_k_score
.seh_proc am_k_score
am_k_score:
 .seh_endprologue
 xor eax,eax
 test r8,r8
 jz .Lscore_done
.Lscore_loop:
 mulsd xmm0,QWORD PTR [rdx+8]
 add rdx,16
 dec r8
 jnz .Lscore_loop
.Lscore_done:
 mov rax,QWORD PTR [rsp+40]
 movsd QWORD PTR [rax],xmm0
 xorpd xmm1,xmm1
 ucomisd xmm0,xmm1
 jbe .Lscore_return
 mulsd xmm3,QWORD PTR [rip+.Lboundary]
 addsd xmm0,xmm3
.Lscore_return:
 ret
.seh_endproc

.globl am_k_weight
.seh_proc am_k_weight
am_k_weight:
 .seh_endprologue
 test rdx,rdx
 jz .Lweight_invalid
 movq rax,xmm0
 mov r9,0x7fffffffffffffff
 and rax,r9
 mov r9,0x7ff0000000000000
 cmp rax,r9
 jae .Lweight_invalid
 xorpd xmm1,xmm1
 ucomisd xmm0,xmm1
 jbe .Lweight_zero
 mulsd xmm0,QWORD PTR [rip+.Lthousand]
 ucomisd xmm0,QWORD PTR [rip+.Li64_limit]
 jae .Lweight_overflow
 cvttsd2si rax,xmm0
 mov QWORD PTR [rdx],rax
 xor eax,eax
 ret
.Lweight_zero:
 mov QWORD PTR [rdx],0
 xor eax,eax
 ret
.Lweight_invalid:
 mov eax,1
 ret
.Lweight_overflow:
 mov eax,2
 ret
.seh_endproc

.globl am_k_modulo
.seh_proc am_k_modulo
am_k_modulo:
 .seh_endprologue
 test r8,r8
 jz .Lmod_invalid
 test rdx,rdx
 jle .Lmod_invalid
 mov r9,rdx
 mov rax,rcx
 xor edx,edx
 div r9
 mov QWORD PTR [r8],rdx
 xor eax,eax
 ret
.Lmod_invalid:
 mov eax,1
 ret
.seh_endproc

.globl am_k_group
.seh_proc am_k_group
am_k_group:
 .seh_endprologue
 xor eax,eax
 cmp ecx,3
 jle .Lgroup_return
 inc eax
 cmp ecx,6
 jle .Lgroup_return
 inc eax
.Lgroup_return:
 ret
.seh_endproc

.globl am_k_rank_compare
.seh_proc am_k_rank_compare
am_k_rank_compare:
 .seh_endprologue
 movsd xmm0,QWORD PTR [rcx+8]
 ucomisd xmm0,QWORD PTR [rdx+8]
 ja .Lrank_before
 jb .Lrank_after
 mov rax,QWORD PTR [rcx+16]
 cmp rax,QWORD PTR [rdx+16]
 jl .Lrank_before
 jg .Lrank_after
 mov rax,QWORD PTR [rcx]
 cmp rax,QWORD PTR [rdx]
 jb .Lrank_before
 ja .Lrank_after
 xor eax,eax
 ret
.Lrank_before:
 mov eax,-1
 ret
.Lrank_after:
 mov eax,1
 ret
.seh_endproc

/* Candidate fields are normalized only for presence/type by the C boundary.
 * Every path's factor arithmetic and dispatch is here. flags: strict=1,key=2,
 * loose=4,strict-nil=8,no-vocal-overlap=16,out-loud=32,valid-db-ratio=64. */
.globl am_k_path_factors
.seh_proc am_k_path_factors
am_k_path_factors:
 .seh_endprologue
 mov QWORD PTR [rdx+48],0
 xorpd xmm2,xmm2
 test QWORD PTR [rcx+16],1
 jz .Lstrict_ready
 movsd xmm2,QWORD PTR [rip+.Lone]
.Lstrict_ready:
 xorpd xmm3,xmm3
 cmp QWORD PTR [rcx+24],8
 jl .Lbars_ready
 movsd xmm3,QWORD PTR [rip+.Lone]
.Lbars_ready:
 movsd xmm4,QWORD PTR [rip+.Lone]
 mov rax,QWORD PTR [rcx+64]
 cmp rax,3
 je .Lvocal_reduce
 cmp rax,4
 jne .Lvocal_ready
.Lvocal_reduce:
 movsd xmm4,QWORD PTR [rip+.Lthree_quarters]
.Lvocal_ready:
 movsd xmm5,QWORD PTR [rip+.Lone]
 test QWORD PTR [rcx+16],64
 jz .Lratio_ready
 movsd xmm5,QWORD PTR [rcx+72]
 divsd xmm5,QWORD PTR [rcx+80]
.Lratio_ready:
 mov r8,QWORD PTR [rcx+32]
 movsd xmm0,QWORD PTR [rcx+56]
 ucomisd xmm0,QWORD PTR [rip+.Lhalf]
 jne .Lalias_double
 shr r8,1
 jmp .Lalias_ready
.Lalias_double:
 ucomisd xmm0,QWORD PTR [rip+.Ltwo]
 jne .Lalias_ready
 shl r8,1
.Lalias_ready:
 shr r8,2
 mov r9,QWORD PTR [rcx+40]
 shr r9,2
 cvtsi2sd xmm1,r8
 movapd xmm0,xmm1
 divsd xmm1,QWORD PTR [rcx+48]
 test r9,r9
 jz .Lrelative_ready_zero
 cvtsi2sd xmm0,r9
 cvtsi2sd xmm1,r8
 divsd xmm1,xmm0
 xorpd xmm0,xmm0
 ucomisd xmm1,QWORD PTR [rip+.Lthree_quarters]
 jb .Lrelative_ready
 movsd xmm0,QWORD PTR [rip+.Lone]
 jmp .Lrelative_ready
.Lrelative_ready_zero:
 xorpd xmm0,xmm0
.Lrelative_ready:
 cvtsi2sd xmm1,r8
 divsd xmm1,QWORD PTR [rcx+48]
 mov rax,QWORD PTR [rcx]
 cmp eax,0
 je .Lpath_dance
 cmp eax,1
 je .Lpath_dance_shift
 cmp eax,2
 je .Lpath_filter
 cmp eax,3
 je .Lpath_filter_shift
 cmp eax,5
 jle .Lpath_hiphop
 cmp eax,6
 je .Lpath_pop
 cmp eax,7
 je .Lpath_smart
 ret
.Lpath_dance:
 movsd QWORD PTR [rdx],xmm2
 movsd QWORD PTR [rdx+8],xmm3
 movsd QWORD PTR [rdx+16],xmm4
 mov QWORD PTR [rdx+48],3
 ret
.Lpath_dance_shift:
 movsd QWORD PTR [rdx],xmm2
 xorpd xmm0,xmm0
 test QWORD PTR [rcx+16],2
 jz .Lds_key
 movsd xmm0,QWORD PTR [rip+.Lone]
.Lds_key:
 movsd QWORD PTR [rdx+8],xmm0
 movsd QWORD PTR [rdx+16],xmm3
 movsd QWORD PTR [rdx+24],xmm5
 mov QWORD PTR [rdx+48],4
 ret
.Lpath_filter:
 movsd QWORD PTR [rdx],xmm2
 cmp QWORD PTR [rcx+8],9
 je .Lfilter_nine
 movsd QWORD PTR [rdx+8],xmm4
 movsd QWORD PTR [rdx+16],xmm1
 movsd QWORD PTR [rdx+24],xmm5
 mov QWORD PTR [rdx+48],4
 ret
.Lfilter_nine:
 xorpd xmm0,xmm0
 test QWORD PTR [rcx+16],2
 jz .Lf9_key
 movsd xmm0,QWORD PTR [rip+.Lone]
.Lf9_key:
 movsd QWORD PTR [rdx+8],xmm0
 movsd QWORD PTR [rdx+16],xmm3
 xorpd xmm0,xmm0
 test QWORD PTR [rcx+16],16
 jz .Lf9_vocal
 movsd xmm0,QWORD PTR [rip+.Lone]
.Lf9_vocal:
 movsd QWORD PTR [rdx+24],xmm0
 movsd QWORD PTR [rdx+32],xmm4
 movsd QWORD PTR [rdx+40],xmm5
 mov QWORD PTR [rdx+48],6
 ret
.Lpath_filter_shift:
 xorpd xmm0,xmm0
 mov rax,QWORD PTR [rcx+16]
 and eax,13
 cmp eax,4
 jne .Lfs_tempo
 movsd xmm0,QWORD PTR [rip+.Lone]
.Lfs_tempo:
 movsd QWORD PTR [rdx],xmm0
 movsd QWORD PTR [rdx+8],xmm3
 movsd QWORD PTR [rdx+16],xmm4
 movsd QWORD PTR [rdx+24],xmm5
 mov QWORD PTR [rdx+48],4
 ret
.Lpath_hiphop:
 movsd QWORD PTR [rdx],xmm4
 movsd QWORD PTR [rdx+8],xmm0
 movsd QWORD PTR [rdx+16],xmm1
 movsd QWORD PTR [rdx+24],xmm5
 mov QWORD PTR [rdx+48],4
 ret
.Lpath_pop:
 movsd QWORD PTR [rdx+8],xmm0
 xorpd xmm0,xmm0
 cvtsi2sd xmm1,r9
 ucomisd xmm1,QWORD PTR [rcx+48]
 jne .Lpop_bars
 movsd xmm0,QWORD PTR [rip+.Lone]
.Lpop_bars:
 movsd QWORD PTR [rdx],xmm0
 movsd QWORD PTR [rdx+16],xmm4
 xorpd xmm0,xmm0
 test QWORD PTR [rcx+16],32
 jz .Lpop_loud
 movsd xmm0,QWORD PTR [rip+.Lone]
.Lpop_loud:
 movsd QWORD PTR [rdx+24],xmm0
 movsd QWORD PTR [rdx+32],xmm5
 mov QWORD PTR [rdx+48],5
 ret
.Lpath_smart:
 mov r8,QWORD PTR [rcx+8]
 xor eax,eax
 cmp QWORD PTR [rcx+96],0
 sete al
 xor r9d,r9d
 cmp r8,3
 sete r9b
 cmp r8,33
 sete r10b
 or r9b,r10b
 cmp al,r9b
 sete al
 cvtsi2sd xmm0,eax
 movsd QWORD PTR [rdx],xmm0
 xor eax,eax
 movsd xmm0,QWORD PTR [rcx+88]
 ucomisd xmm0,QWORD PTR [rip+.Lfive]
 setae al
 xor r9d,r9d
 cmp r8,3
 sete r9b
 cmp r8,4
 sete r10b
 or r9b,r10b
 cmp al,r9b
 sete al
 cvtsi2sd xmm0,eax
 movsd QWORD PTR [rdx+8],xmm0
 mov QWORD PTR [rdx+48],2
 ret
.seh_endproc
.section .rdata,"dr"
.p2align 3
.Lone: .double 1
.Lhalf: .double 0.5
.Ltwo: .double 2
.Lfive: .double 5
.Lthree_quarters: .double 0.75
.Lboundary: .double 0.001
.Lthousand: .double 1000
.Li64_limit: .double 9223372036854775808.0
